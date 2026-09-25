use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{self, Child, Command, Stdio};
use std::thread;
use std::time::Duration;
use std::{error::Error, fmt};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_CONTROL_BYTES: usize = 8 * 1024 * 1024;
const MAX_CWD_BYTES: usize = 16 * 1024;
const MAX_ENV_BYTES: usize = 128 * 1024;
const MAX_ENV_ENTRIES: usize = 256;

const RUNNER_SOURCE: &str = r#"set +e
set -m
readonly __linden_command=$1
readonly __linden_state_dir=$2
builtin eval -- "$__linden_command"
__linden_status=$?
/bin/pwd -P > "$__linden_state_dir/cwd" 2>/dev/null || true
/usr/bin/env -0 > "$__linden_state_dir/env" 2>/dev/null || true
builtin exit "$__linden_status""#;

const DENIED_NAMES: &[&str] = &[
    "BASH_ENV",
    "ENV",
    "PATH",
    "HOME",
    "SHELL",
    "IFS",
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "SHELLOPTS",
    "BASHOPTS",
    "PROMPT_COMMAND",
    "PS0",
    "PS1",
    "PS2",
    "PS3",
    "PS4",
    "CDPATH",
    "GLOBIGNORE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONSTARTUP",
    "PYTHONPATH",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "GIT_SSH_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "SSH_ASKPASS",
    "PAGER",
    "MANPAGER",
    "LESSOPEN",
    "LESSCLOSE",
    "EDITOR",
    "VISUAL",
];
const DENIED_PREFIXES: &[&str] = &[
    "BASH_FUNC_",
    "LD_",
    "DYLD_",
    "LINDEN_",
    "PYTHON",
    "PERL",
    "RUBY",
    "NODE_",
];
const INHERITED_DENIED_PREFIXES: &[&str] = &["BASH_FUNC_", "LD_", "DYLD_"];
const JOB_SIGNALS: &[libc::c_int] = &[
    libc::SIGINT,
    libc::SIGQUIT,
    libc::SIGTSTP,
    libc::SIGTTIN,
    libc::SIGTTOU,
];

type AnyResult<T> = Result<T, Box<dyn Error>>;

#[derive(Debug)]
struct MessageError(String);

impl fmt::Display for MessageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for MessageError {}

fn fail<T>(message: impl Into<String>) -> AnyResult<T> {
    Err(Box::new(MessageError(message.into())))
}

struct ActiveCommand {
    id: String,
    child: Child,
    state_dir: PathBuf,
}

struct Supervisor {
    control: std::os::unix::net::UnixStream,
    marker: String,
    supervisor_pgrp: libc::pid_t,
    current: Option<ActiveCommand>,
    buffer: Vec<u8>,
}

impl Supervisor {
    fn connect(control_path: &Path, marker: String) -> AnyResult<Self> {
        unsafe {
            libc::umask(0o077);
            if libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 {
                return Err(Box::new(io::Error::last_os_error()));
            }
            for &signal in JOB_SIGNALS {
                libc::signal(signal, libc::SIG_IGN);
            }
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
        let control = std::os::unix::net::UnixStream::connect(control_path)?;
        let descriptor = control.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(descriptor, libc::F_GETFD);
            if flags < 0 || libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0 {
                return Err(Box::new(io::Error::last_os_error()));
            }
        }
        Ok(Self {
            control,
            marker,
            supervisor_pgrp: unsafe { libc::getpgrp() },
            current: None,
            buffer: Vec::new(),
        })
    }

    fn emit(&mut self, mut record: Value) -> AnyResult<()> {
        let object = record
            .as_object_mut()
            .ok_or_else(|| MessageError("internal control record is not an object".into()))?;
        object.insert("marker".into(), Value::String(self.marker.clone()));
        serde_json::to_writer(&mut self.control, &record)?;
        self.control.write_all(b"\n")?;
        self.control.flush()?;
        Ok(())
    }

    fn run(&mut self) -> AnyResult<()> {
        self.emit(json!({"type": "ready"}))?;
        loop {
            let timeout = if self.current.is_some() { 20 } else { -1 };
            let mut descriptor = libc::pollfd {
                fd: self.control.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = loop {
                let result = unsafe { libc::poll(&mut descriptor, 1, timeout) };
                if result >= 0 {
                    break result;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(Box::new(error));
                }
            };
            if ready > 0 {
                if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                    return fail("control channel failed");
                }
                if descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                    self.read_control()?;
                }
            }
            self.finish_command()?;
        }
    }

    fn read_control(&mut self) -> AnyResult<()> {
        let mut chunk = [0u8; 65_536];
        let count = self.control.read(&mut chunk)?;
        if count == 0 {
            return fail("control channel closed");
        }
        self.buffer.extend_from_slice(&chunk[..count]);
        if self.buffer.len() > MAX_CONTROL_BYTES {
            return fail("control record exceeded limit");
        }
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=newline).collect();
            let record: Value = serde_json::from_slice(&line[..line.len() - 1])?;
            self.handle(record)?;
        }
        Ok(())
    }

    fn handle(&mut self, record: Value) -> AnyResult<()> {
        let object = record
            .as_object()
            .ok_or_else(|| MessageError("invalid control record".into()))?;
        if object.get("marker").and_then(Value::as_str) != Some(self.marker.as_str()) {
            return fail("invalid control marker");
        }
        match object.get("type").and_then(Value::as_str) {
            Some("exec") => self.start_command(object),
            Some("interrupt") => self.interrupt(object, libc::SIGINT),
            Some("kill") => self.kill(object),
            _ => fail("unknown control record"),
        }
    }

    fn start_command(&mut self, record: &Map<String, Value>) -> AnyResult<()> {
        if self.current.is_some() {
            return fail("exec received while a foreground is running");
        }
        let command_id = required_string(record, "id")?;
        let payload = required_string(record, "command")?;
        let cwd = PathBuf::from(required_string(record, "cwd")?);
        let additions = record
            .get("env")
            .and_then(Value::as_object)
            .ok_or_else(|| MessageError("invalid exec record".into()))?;
        if command_id.is_empty() || !cwd.is_absolute() {
            return fail("invalid exec record");
        }
        if additions.len() > MAX_ENV_ENTRIES {
            return fail("environment record is too large");
        }
        let command_bytes = decode_base64(payload)?;
        if command_bytes.contains(&0) {
            return fail("command contains a NUL byte");
        }
        let command_text = String::from_utf8(command_bytes)
            .map_err(|_| MessageError("command is not valid UTF-8".into()))?;
        let mut environment = HashMap::new();
        for (name, value) in additions {
            let value = value
                .as_str()
                .ok_or_else(|| MessageError("unsafe environment record".into()))?;
            if !safe_env_name(name) {
                return fail("unsafe environment record");
            }
            environment.insert(name.clone(), value.to_owned());
        }
        let state_dir = make_state_dir()?;
        let launch = self.spawn_command(&command_text, &cwd, &environment, &state_dir);
        let mut child = match launch {
            Ok(child) => child,
            Err(error) => {
                cleanup_state(&state_dir);
                return Err(error);
            }
        };
        let pid = child.id() as libc::pid_t;
        unsafe {
            if libc::tcsetpgrp(libc::STDIN_FILENO, pid) != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    let _ = libc::killpg(pid, libc::SIGKILL);
                    let _ = child.wait();
                    cleanup_state(&state_dir);
                    return Err(Box::new(error));
                }
            }
            if libc::killpg(pid, libc::SIGCONT) != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    let _ = libc::killpg(pid, libc::SIGKILL);
                    let _ = child.wait();
                    cleanup_state(&state_dir);
                    return Err(Box::new(error));
                }
            }
        }
        self.current = Some(ActiveCommand {
            id: command_id.to_owned(),
            child,
            state_dir,
        });
        self.emit(json!({"type": "started", "id": command_id}))
    }

    fn spawn_command(
        &self,
        command_text: &str,
        cwd: &Path,
        additions: &HashMap<String, String>,
        state_dir: &Path,
    ) -> AnyResult<Child> {
        let mut command = Command::new("/bin/bash");
        command
            .args([
                "--noprofile",
                "--norc",
                "-m",
                "-c",
                RUNNER_SOURCE,
                "linden-term-runner",
                command_text,
            ])
            .arg(state_dir)
            .current_dir(cwd)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        for (name, _) in env::vars_os() {
            let name_text = name.to_string_lossy();
            if name_text == "BASH_ENV"
                || name_text == "ENV"
                || INHERITED_DENIED_PREFIXES
                    .iter()
                    .any(|prefix| name_text.starts_with(prefix))
            {
                command.env_remove(name);
            }
        }
        command.envs(additions);
        unsafe {
            command.pre_exec(|| {
                libc::signal(libc::SIGTTOU, libc::SIG_IGN);
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::tcsetpgrp(libc::STDIN_FILENO, libc::getpgrp()) != 0 {
                    return Err(io::Error::last_os_error());
                }
                for &signal in JOB_SIGNALS {
                    libc::signal(signal, libc::SIG_DFL);
                }
                Ok(())
            });
        }
        Ok(command.spawn()?)
    }

    fn interrupt(&mut self, record: &Map<String, Value>, signal: libc::c_int) -> AnyResult<()> {
        let supervisor_pgrp = self.supervisor_pgrp;
        let current = self.named_current(record, "interrupt")?;
        let foreground = unsafe { libc::tcgetpgrp(libc::STDIN_FILENO) };
        let result = if foreground > 0 && foreground != supervisor_pgrp {
            unsafe { libc::killpg(foreground, signal) }
        } else {
            unsafe { libc::kill(current.child.id() as libc::pid_t, signal) }
        };
        if result != 0 {
            return Err(Box::new(io::Error::last_os_error()));
        }
        Ok(())
    }

    fn kill(&mut self, record: &Map<String, Value>) -> AnyResult<()> {
        let supervisor_pgrp = self.supervisor_pgrp;
        let current = self.named_current(record, "kill")?;
        let command_group = current.child.id() as libc::pid_t;
        let foreground = unsafe { libc::tcgetpgrp(libc::STDIN_FILENO) };
        if foreground > 0 && foreground != supervisor_pgrp && foreground != command_group {
            ignore_missing(unsafe { libc::killpg(foreground, libc::SIGKILL) })?;
        }
        ignore_missing(unsafe { libc::killpg(command_group, libc::SIGKILL) })
    }

    fn named_current(
        &mut self,
        record: &Map<String, Value>,
        operation: &str,
    ) -> AnyResult<&mut ActiveCommand> {
        let expected = record.get("id").and_then(Value::as_str);
        match self.current.as_mut() {
            Some(current) if expected == Some(current.id.as_str()) => Ok(current),
            _ => fail(format!("{operation} does not name the active foreground")),
        }
    }

    fn finish_command(&mut self) -> AnyResult<()> {
        let status = match self.current.as_mut() {
            Some(current) => current.child.try_wait()?,
            None => return Ok(()),
        };
        let Some(status) = status else {
            return Ok(());
        };
        unsafe {
            let _ = libc::tcsetpgrp(libc::STDIN_FILENO, self.supervisor_pgrp);
        }
        let current = self.current.take().expect("current command disappeared");
        let cwd_data = safe_read(&current.state_dir.join("cwd"), MAX_CWD_BYTES);
        let env_data = safe_read(&current.state_dir.join("env"), MAX_ENV_BYTES);
        cleanup_state(&current.state_dir);
        let exit_code = match status.code() {
            Some(code) => code,
            None => 128 + status.signal().unwrap_or(libc::SIGKILL),
        };
        self.emit(json!({
            "type": "done",
            "id": current.id,
            "exitCode": exit_code.clamp(0, 255),
            "cwd": encode_base64(&cwd_data),
            "env": encode_base64(&env_data),
        }))
    }

    fn fail_closed(&mut self, error: &dyn fmt::Display) {
        let _ = self.emit(json!({"type": "fatal", "message": error.to_string()}));
        if let Some(mut current) = self.current.take() {
            unsafe {
                let _ = libc::killpg(current.child.id() as libc::pid_t, libc::SIGKILL);
            }
            let _ = current.child.wait();
            cleanup_state(&current.state_dir);
        }
        unsafe {
            let _ = libc::tcsetpgrp(libc::STDIN_FILENO, self.supervisor_pgrp);
        }
    }
}

fn required_string<'a>(record: &'a Map<String, Value>, name: &str) -> AnyResult<&'a str> {
    record
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Box::new(MessageError("invalid exec record".into())) as Box<dyn Error>)
}

fn safe_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !(first == b'_' || first.is_ascii_alphabetic())
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
    {
        return false;
    }
    !DENIED_NAMES.contains(&name)
        && !DENIED_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn make_state_dir() -> AnyResult<PathBuf> {
    let mut template = b"/tmp/linden-term-state-XXXXXX\0".to_vec();
    let pointer = unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) };
    if pointer.is_null() {
        return Err(Box::new(io::Error::last_os_error()));
    }
    template.pop();
    Ok(PathBuf::from(OsString::from_vec(template)))
}

fn cleanup_state(state_dir: &Path) {
    for name in ["cwd", "env"] {
        let _ = fs::remove_file(state_dir.join(name));
    }
    let _ = fs::remove_dir(state_dir);
}

fn safe_read(path: &Path, limit: usize) -> Vec<u8> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    let Ok(mut file) = options.open(path) else {
        return Vec::new();
    };
    let Ok(metadata) = file.metadata() else {
        return Vec::new();
    };
    if !metadata.file_type().is_file() {
        return Vec::new();
    }
    let mut result = Vec::with_capacity(metadata.len().min(limit as u64) as usize);
    if Read::by_ref(&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut result)
        .is_err()
        || result.len() > limit
    {
        return Vec::new();
    }
    result
}

fn ignore_missing(result: libc::c_int) -> AnyResult<()> {
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(Box::new(error))
    }
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn decode_base64(input: &str) -> AnyResult<Vec<u8>> {
    if input.len() % 4 != 0 {
        return fail("command is not valid base64");
    }
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for (chunk_index, chunk) in input.as_bytes().chunks(4).enumerate() {
        let last = chunk_index + 1 == input.len() / 4;
        let first = base64_value(chunk[0])?;
        let second = base64_value(chunk[1])?;
        let third_padding = chunk[2] == b'=';
        let fourth_padding = chunk[3] == b'=';
        if third_padding && !fourth_padding {
            return fail("command is not valid base64");
        }
        if !last && (third_padding || fourth_padding) {
            return fail("command is not valid base64");
        }
        if (!third_padding && base64_value(chunk[2]).is_err())
            || (!fourth_padding && base64_value(chunk[3]).is_err())
        {
            return fail("command is not valid base64");
        }
        output.push((first << 2) | (second >> 4));
        if !third_padding {
            let third = base64_value(chunk[2])?;
            output.push((second << 4) | (third >> 2));
            if !fourth_padding {
                let fourth = base64_value(chunk[3])?;
                output.push((third << 6) | fourth);
            }
        }
    }
    Ok(output)
}

fn base64_value(byte: u8) -> AnyResult<u8> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => fail("command is not valid base64"),
    }
}

fn port_is_listening(port: u16) -> bool {
    let needle = format!(":{port:04X}");
    ["/proc/net/tcp", "/proc/net/tcp6"].iter().any(|path| {
        let Ok(table) = fs::read_to_string(path) else {
            return false;
        };
        table.lines().any(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            fields.len() > 3 && fields[1].ends_with(&needle) && fields[3] == "0A"
        })
    })
}

fn loopback_monitor(arguments: &[String]) -> AnyResult<()> {
    if arguments.len() != 2 {
        return fail("usage: linden-term-supervisor loopback-monitor PORT SOCKET");
    }
    let port: u16 = arguments[0]
        .parse()
        .map_err(|_| MessageError("loopback port must be in 1..65535".into()))?;
    if port == 0 {
        return fail("loopback port must be in 1..65535");
    }
    let socket = Path::new(&arguments[1]);
    if !socket.is_absolute()
        || !arguments[1].starts_with("/tmp/linden-term-expose-")
        || arguments[1].contains('\0')
    {
        return fail("invalid loopback exposure socket");
    }
    while !port_is_listening(port) {
        thread::sleep(Duration::from_millis(50));
    }
    let listen = format!(
        "UNIX-LISTEN:{},fork,mode=600,unlink-early",
        socket.display()
    );
    let target = format!("TCP:127.0.0.1:{port}");
    let error = Command::new("socat").args([listen, target]).exec();
    Err(Box::new(error))
}

fn supervisor_main(control_path: &str, marker: &str) -> i32 {
    if marker.is_empty() || !Path::new(control_path).is_absolute() {
        eprintln!("invalid supervisor arguments");
        return 64;
    }
    let mut supervisor = match Supervisor::connect(Path::new(control_path), marker.to_owned()) {
        Ok(supervisor) => supervisor,
        Err(error) => {
            eprintln!("linden-term-supervisor: {error}");
            return 70;
        }
    };
    match supervisor.run() {
        Ok(()) => 0,
        Err(error) => {
            supervisor.fail_closed(error.as_ref());
            70
        }
    }
}

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.as_slice() == ["--version"] {
        println!("linden-term-supervisor {VERSION}");
        return;
    }
    if arguments.first().map(String::as_str) == Some("loopback-monitor") {
        if let Err(error) = loopback_monitor(&arguments[1..]) {
            eprintln!("linden-term-supervisor: {error}");
            process::exit(70);
        }
        return;
    }
    if arguments.len() != 2 {
        eprintln!("usage: linden-term-supervisor CONTROL_SOCKET MARKER");
        process::exit(64);
    }
    process::exit(supervisor_main(&arguments[0], &arguments[1]));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn base64_round_trips_binary_data() {
        for input in [
            b"".as_slice(),
            b"a".as_slice(),
            b"ab".as_slice(),
            b"abc".as_slice(),
            b"\0\xff\ncommand".as_slice(),
        ] {
            assert_eq!(decode_base64(&encode_base64(input)).unwrap(), input);
        }
        for invalid in ["=", "abc", "a===", "ab=c", "!!!!", "YWJj===="] {
            assert!(decode_base64(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn environment_name_policy_matches_host_contract() {
        for safe in ["A", "_VALUE", "hello_2"] {
            assert!(safe_env_name(safe), "{safe}");
        }
        for unsafe_name in [
            "",
            "2BAD",
            "BAD-NAME",
            "PATH",
            "LD_PRELOAD",
            "LINDEN_MARKER",
            "NODE_OPTIONS",
        ] {
            assert!(!safe_env_name(unsafe_name), "{unsafe_name}");
        }
    }

    #[test]
    fn safe_state_reads_reject_symlinks_and_oversize_files() {
        let directory = make_state_dir().unwrap();
        let regular = directory.join("regular");
        fs::write(&regular, b"ok").unwrap();
        assert_eq!(safe_read(&regular, 2), b"ok");
        assert!(safe_read(&regular, 1).is_empty());
        let link = directory.join("link");
        symlink(&regular, &link).unwrap();
        assert!(safe_read(&link, 10).is_empty());
        let _ = fs::remove_file(regular);
        let _ = fs::remove_file(link);
        let _ = fs::remove_dir(directory);
    }
}
