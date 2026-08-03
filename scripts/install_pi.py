#!/usr/bin/env python3
"""
Spomienka Digital Frame Installer for Raspberry Pi 4 (64-bit)

Installs SDL2/GStreamer/ffmpeg deps, rustup, optional PocketBase, optional
local Admin UI, builds the viewer and configures systemd services.

All user input is collected upfront; installation proceeds non-interactively.

Non-interactive env vars:
  NONINTERACTIVE=y      Skip all prompts (use defaults)
  INSTALL_POCKETBASE=y|n
  INSTALL_ADMIN=y|n
  ENABLE_TLS=y|n
  PB_VERSION=0.25.0
  REPO_URL=https://github.com/jasonarmbrecht/spomienka.git
  REPO_BRANCH=main
"""

# Bootstrap rich before any other imports
try:
    from rich.console import Console
except ImportError:
    import subprocess, sys
    subprocess.run([sys.executable, "-m", "pip", "install", "rich", "-q"], check=True)
    from rich.console import Console

import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from rich import print as rprint
from rich.columns import Columns
from rich.panel import Panel
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn
from rich.prompt import Confirm, Prompt
from rich.rule import Rule
from rich.status import Status
from rich.table import Table

console = Console()

# ─── Defaults ────────────────────────────────────────────────────────────────

PB_VERSION = os.environ.get("PB_VERSION", "0.25.0")
REPO_URL = os.environ.get("REPO_URL", "https://github.com/jasonarmbrecht/spomienka.git")
REPO_BRANCH = os.environ.get("REPO_BRANCH", "main")
ADMIN_PORT_DEFAULT = 4173
PB_PORT_DEFAULT = 8090
PB_HOST_INTERNAL = f"http://localhost:{PB_PORT_DEFAULT}"
VIEWER_BIN_NAME = "frame-viewer"
PB_BIN_PATH = "/opt/pocketbase/pocketbase"
PB_DATA_DIR = "/var/lib/pocketbase"
VIEWER_CONFIG = "/etc/frame-viewer/config.toml"
VIEWER_CACHE = "/var/cache/frame-viewer"
INSTALL_DIR = str(Path.home() / "spomienka")

# Maps platform.machine() to PocketBase's release asset architecture suffix.
PB_ARCH_MAP = {"aarch64": "arm64", "x86_64": "amd64", "armv7l": "armv7"}

NONINTERACTIVE = os.environ.get("NONINTERACTIVE", "").lower() in ("y", "yes", "true", "1")


# ─── Helpers ─────────────────────────────────────────────────────────────────

def run(cmd: list[str], check: bool = True, capture: bool = False, env: Optional[dict] = None) -> subprocess.CompletedProcess:
    merged_env = {**os.environ, **(env or {})}
    return subprocess.run(cmd, check=check, capture_output=capture, text=True, env=merged_env)


def run_shell(cmd: str, check: bool = True, capture: bool = False, env: Optional[dict] = None) -> subprocess.CompletedProcess:
    merged_env = {**os.environ, **(env or {})}
    return subprocess.run(cmd, shell=True, check=check, capture_output=capture, text=True, env=merged_env)


def step_ok(msg: str) -> None:
    console.print(f"  [green]✓[/green] {msg}")


def step_fail(msg: str) -> None:
    console.print(f"  [red]✗[/red] {msg}")


def step_warn(msg: str) -> None:
    console.print(f"  [yellow]![/yellow] {msg}")


def require_cmd(name: str) -> None:
    if not shutil.which(name):
        console.print(f"[red]Missing required command: {name}. Aborting.[/red]")
        sys.exit(1)


def is_mountpoint(path: str) -> bool:
    return subprocess.run(["mountpoint", "-q", path]).returncode == 0


# Filesystems that are never a real storage candidate (kernel/virtual mounts).
_VIRTUAL_FSTYPES = {
    "proc", "sysfs", "devtmpfs", "tmpfs", "cgroup", "cgroup2", "overlay",
    "squashfs", "devpts", "mqueue", "debugfs", "tracefs", "configfs",
    "fusectl", "binfmt_misc", "autofs", "pstore", "securityfs", "efivarfs", "ramfs",
}
_SYSTEM_MOUNT_PREFIXES = ("/boot", "/proc", "/sys", "/dev", "/run")


def detect_candidate_mounts() -> list[dict]:
    """Currently-mounted, non-system filesystems — read-only detection via findmnt.

    Never partitions/formats anything; only lists what's already mounted.
    """
    result = subprocess.run(
        ["findmnt", "-J", "-o", "TARGET,SOURCE,FSTYPE,SIZE"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
    except Exception:
        return []

    def flatten(nodes):
        for node in nodes:
            yield node
            yield from flatten(node.get("children", []))

    candidates = []
    for node in flatten(data.get("filesystems", [])):
        target = node.get("target", "")
        fstype = node.get("fstype", "")
        if not target or fstype in _VIRTUAL_FSTYPES:
            continue
        if target == "/" or target in _SYSTEM_MOUNT_PREFIXES or target.startswith(
            tuple(p + "/" for p in _SYSTEM_MOUNT_PREFIXES)
        ):
            continue
        candidates.append(node)
    return candidates


def detect_unmounted_partitions() -> list[dict]:
    """Plugged-in partitions with an existing filesystem that aren't mounted yet.

    Read-only inspection via lsblk. Never formats — a partition with no
    filesystem (empty FSTYPE) is excluded; the user must format it manually
    (see docs/installer.md 'USB Storage Setup') before it will show up here.
    """
    result = subprocess.run(
        ["lsblk", "-J", "-o", "NAME,PATH,SIZE,FSTYPE,LABEL,MOUNTPOINT,UUID"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
    except Exception:
        return []

    def flatten(nodes):
        for node in nodes:
            yield node
            yield from flatten(node.get("children", []))

    candidates = []
    for node in flatten(data.get("blockdevices", [])):
        fstype = node.get("fstype") or ""
        mountpoint = node.get("mountpoint") or ""
        uuid = node.get("uuid") or ""
        if not fstype or fstype == "swap" or mountpoint or not uuid:
            continue
        candidates.append(node)
    return candidates


def auto_mount_partition(part: dict) -> str:
    """Create a mount point, add a persistent fstab entry (if not already there), and mount now.

    Only ever mounts an existing filesystem — never runs mkfs/fdisk.
    """
    mount_path = f"/mnt/spomienka-{part.get('name', 'disk')}"
    run(["sudo", "mkdir", "-p", mount_path])
    fstab = Path("/etc/fstab").read_text()
    if part["uuid"] not in fstab:
        fstab_line = f"UUID={part['uuid']} {mount_path} {part['fstype']} defaults,nofail 0 2"
        run_shell(f"echo '{fstab_line}' | sudo tee -a /etc/fstab > /dev/null")
    run(["sudo", "mount", "-a"], check=False)
    return mount_path


def pick_mount(label: str) -> str:
    """Prompt for a mount point, offering a picker of detected drives as a shortcut.

    Already-mounted filesystems are used as-is. Plugged-in, already-formatted,
    unmounted partitions are mounted (fstab entry + `mount -a`) when selected.
    Never partitions or formats anything itself.
    """
    if NONINTERACTIVE:
        return ask_value(f"Mount point for {label} (leave blank to use the SD card)", default="")

    mounted = detect_candidate_mounts()
    unmounted = detect_unmounted_partitions()

    if not mounted and not unmounted:
        console.print(f"  No external drives detected for {label}.")
        return ask_value(f"Mount point for {label} (leave blank to use the SD card)", default="")

    console.print(f"  Detected drives for {label}:")
    table = Table(show_header=True, box=None, padding=(0, 1))
    table.add_column("#", style="bold")
    table.add_column("Location")
    table.add_column("Filesystem")
    table.add_column("Size")
    table.add_column("Status")

    rows: list[tuple[str, dict]] = []
    for c in mounted:
        rows.append(("mounted", c))
        table.add_row(str(len(rows)), c.get("target", ""), c.get("fstype", ""), c.get("size", ""), "mounted")
    for c in unmounted:
        rows.append(("unmounted", c))
        table.add_row(str(len(rows)), c.get("path", ""), c.get("fstype", ""), c.get("size", ""), "not mounted yet")
    console.print(table)

    choice = ask_value(
        f"Select a number for {label}, type a custom mount path, or leave blank for the SD card",
        default="",
    )
    if choice.isdigit() and 1 <= int(choice) <= len(rows):
        kind, node = rows[int(choice) - 1]
        if kind == "mounted":
            return node["target"]
        with Status(f"Mounting {node['path']}…", console=console):
            mount_path = auto_mount_partition(node)
        if is_mountpoint(mount_path):
            step_ok(f"Mounted {node['path']} at {mount_path}")
            return mount_path
        step_warn(f"Failed to mount {node['path']} automatically — falling back to manual entry")
        return ask_value(f"Mount point for {label} (leave blank to use the SD card)", default="")
    return choice


def generate_password() -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(16))


def ask_yes_no(prompt: str, default: bool = True) -> bool:
    if NONINTERACTIVE:
        answer = "y" if default else "n"
        console.print(f"  {prompt} [[{'Y' if default else 'y'}/{'n' if default else 'N'}]]: [dim]{answer} (auto)[/dim]")
        return default
    return Confirm.ask(f"  {prompt}", default=default)


def ask_value(prompt: str, default: str = "") -> str:
    if NONINTERACTIVE:
        console.print(f"  {prompt} [dim][{default}][/dim]: [dim]{default} (auto)[/dim]")
        return default
    result = Prompt.ask(f"  {prompt}", default=default)
    return result


# ─── API helpers ─────────────────────────────────────────────────────────────

def wait_for_pocketbase(api_url: str, max_attempts: int = 30) -> bool:
    import urllib.request, urllib.error
    for attempt in range(max_attempts):
        try:
            urllib.request.urlopen(f"{api_url}/api/health", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False


def get_superuser_token(api_url: str, email: str, password: str) -> str:
    import json, urllib.request, urllib.error
    payload = json.dumps({"identity": email, "password": password}).encode()
    req = urllib.request.Request(
        f"{api_url}/api/collections/_superusers/auth-with-password",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("token", "")
    except Exception:
        return ""


def api_get(url: str, token: str = "") -> dict:
    import urllib.request
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", token)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return {}


def api_post(url: str, payload: dict, token: str = "") -> dict:
    import urllib.request
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    if token:
        req.add_header("Authorization", token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"_error": str(e)}


def api_put(url: str, payload: dict, token: str = "") -> dict:
    import urllib.request
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="PUT")
    if token:
        req.add_header("Authorization", token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"_error": str(e)}


def api_patch(url: str, payload: dict, token: str = "") -> dict:
    import urllib.request
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="PATCH")
    if token:
        req.add_header("Authorization", token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"_error": str(e)}


def create_superuser(email: str, password: str) -> bool:
    result = run([PB_BIN_PATH, "superuser", "upsert", email, password, "--dir", PB_DATA_DIR],
                 check=False, capture=True)
    return result.returncode == 0


def verify_collections_exist(api_url: str, token: str) -> tuple[bool, list[str]]:
    required = ["users", "media", "approvals", "devices", "plugins"]
    missing = []
    for col in required:
        data = api_get(f"{api_url}/api/collections/{col}", token)
        if "id" in data:
            step_ok(col)
        else:
            step_fail(f"{col} — NOT FOUND")
            missing.append(col)
    return len(missing) == 0, missing


def import_schema_via_api(api_url: str, superuser_email: str, superuser_password: str, schema_path: str) -> bool:
    token = get_superuser_token(api_url, superuser_email, superuser_password)
    if not token:
        step_fail("Could not authenticate as superuser for schema import")
        return False

    console.print("  Checking existing collections...")
    ok, _ = verify_collections_exist(api_url, token)
    if ok:
        step_ok("Schema already imported — skipping")
        return True

    schema_content = json.loads(Path(schema_path).read_text())
    console.print("  Importing collections from pb_schema.json...")
    resp = api_put(
        f"{api_url}/api/collections/import",
        {"collections": schema_content, "deleteMissing": False},
        token,
    )
    if "code" in resp:
        step_fail(f"Schema import API returned error: {resp}")
        return False

    time.sleep(3)
    ok, missing = verify_collections_exist(api_url, token)
    return ok


def create_admin_user(api_url: str, email: str, password: str, superuser_email: str, superuser_password: str) -> int:
    """Returns 0=created, 1=failed, 2=already exists."""
    token = get_superuser_token(api_url, superuser_email, superuser_password)
    if not token:
        step_fail("Could not authenticate as superuser")
        return 1

    existing = api_get(f"{api_url}/api/collections/users/records?filter=role='admin'&perPage=1", token)
    if existing.get("totalItems", -1) == 0:
        resp = api_post(
            f"{api_url}/api/collections/users/records",
            {"email": email, "password": password, "passwordConfirm": password, "role": "admin"},
            token,
        )
        if "id" in resp:
            return 0
        step_fail(f"Failed to create admin user: {resp}")
        return 1
    elif existing.get("totalItems", -1) > 0:
        return 2
    else:
        # Unexpected response — try anyway
        resp = api_post(
            f"{api_url}/api/collections/users/records",
            {"email": email, "password": password, "passwordConfirm": password, "role": "admin"},
            token,
        )
        return 0 if "id" in resp else 1


def create_local_device(api_url: str, superuser_email: str, superuser_password: str,
                        device_name: str, interval_ms: int, transition: str) -> tuple[str, str]:
    """Returns (device_id, device_key) or ("", "") on failure."""
    token = get_superuser_token(api_url, superuser_email, superuser_password)
    if not token:
        return "", ""

    existing = api_get(
        f"{api_url}/api/collections/devices/records?filter=name='{device_name}'&perPage=1", token
    )
    if existing.get("totalItems", 0) == 1:
        item = existing["items"][0]
        return item.get("id", ""), item.get("apiKey", "")

    api_key = secrets.token_hex(16)
    resp = api_post(
        f"{api_url}/api/collections/devices/records",
        {"name": device_name, "apiKey": api_key,
         "config": {"interval": interval_ms, "transition": transition}},
        token,
    )
    if "id" in resp:
        return resp["id"], api_key
    return "", ""


def download_file(url: str, dest: Path) -> None:
    import urllib.request
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.percentage:>3.0f}%"),
        TimeElapsedColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task(f"Downloading {dest.name}", total=100)

        def reporthook(count: int, block_size: int, total_size: int) -> None:
            if total_size > 0:
                pct = min(100, count * block_size * 100 // total_size)
                progress.update(task, completed=pct)

        urllib.request.urlretrieve(url, dest, reporthook=reporthook)
        progress.update(task, completed=100)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    # ── Header ──────────────────────────────────────────────────────────────
    console.print()
    console.print(Panel(
        "[bold cyan]Spomienka Digital Frame Installer[/bold cyan]\n"
        "[dim]Raspberry Pi 4 · 64-bit · systemd[/dim]",
        border_style="cyan",
        padding=(1, 4),
    ))
    console.print()

    require_cmd("sudo")
    require_cmd("curl")

    # ── Architecture check ───────────────────────────────────────────────────
    arch = platform.machine()
    if arch != "aarch64":
        if arch in PB_ARCH_MAP:
            step_warn(f"Expected aarch64; got {arch} (PocketBase release available, but the viewer build target may still be wrong)")
        else:
            step_warn(f"Expected aarch64; got {arch} — no PocketBase release exists for this architecture")
        if not ask_yes_no("Continue anyway?", default=False):
            console.print("[red]Installation cancelled.[/red]")
            sys.exit(1)

    # ────────────────────────────────────────────────────────────────────────
    console.print(Rule("[bold]Phase 1 — Configuration[/bold]"))
    console.print()
    if NONINTERACTIVE:
        console.print("[dim]Non-interactive mode — using defaults / env overrides.[/dim]\n")
    else:
        console.print("Please answer the questions below.\n[dim]Installation will proceed automatically after.[/dim]\n")

    # Question 1: PocketBase on this Pi?
    _pb_env = os.environ.get("INSTALL_POCKETBASE", "").lower()
    if _pb_env in ("y", "yes"):
        pb_on_pi = True
        console.print(f"  Run PocketBase on this Pi? [dim]y (env override)[/dim]")
    elif _pb_env in ("n", "no"):
        pb_on_pi = False
        console.print(f"  Run PocketBase on this Pi? [dim]n (env override)[/dim]")
    else:
        pb_on_pi = ask_yes_no("Run PocketBase on this Pi?", default=True)

    # Question 2: Admin UI on this Pi?
    _admin_env = os.environ.get("INSTALL_ADMIN", "").lower()
    if _admin_env in ("y", "yes"):
        admin_local = True
        console.print(f"  Serve Admin UI on this Pi? [dim]y (env override)[/dim]")
    elif _admin_env in ("n", "no"):
        admin_local = False
        console.print(f"  Serve Admin UI on this Pi? [dim]n (env override)[/dim]")
    else:
        admin_local = ask_yes_no("Serve Admin UI on this Pi?", default=True)

    # Question 3: Enable TLS?
    _tls_env = os.environ.get("ENABLE_TLS", "").lower()
    if _tls_env in ("y", "yes"):
        enable_tls = True
        console.print(f"  Enable TLS/HTTPS? [dim]y (env override)[/dim]")
    elif _tls_env in ("n", "no"):
        enable_tls = False
        console.print(f"  Enable TLS/HTTPS? [dim]n (env override)[/dim]")
    else:
        enable_tls = ask_yes_no("Enable TLS/HTTPS termination here?", default=False)

    # Question 4: Cross-compile target
    add_cross_target = ask_yes_no(
        "Add aarch64-unknown-linux-gnu cross target (for cross-build reuse)?", default=True
    )

    # Question 5: PocketBase URL (only if remote)
    pb_host_external = PB_HOST_INTERNAL
    if not pb_on_pi:
        pb_host_external = ask_value("PocketBase URL (http://host:8090)", default=f"http://localhost:{PB_PORT_DEFAULT}")

    # Question 6: Admin UI port
    admin_port = ADMIN_PORT_DEFAULT
    if admin_local:
        admin_port = int(ask_value("Admin UI port", default=str(ADMIN_PORT_DEFAULT)))

    # Question 7: Primary storage — PocketBase data + viewer cache on a
    # separate mounted drive instead of the SD card. The installer does not
    # partition/format drives itself — it only validates an existing mount.
    primary_mount = pick_mount("PocketBase data + viewer cache")
    if primary_mount:
        if not is_mountpoint(primary_mount):
            console.print(
                f"[red]ERROR: '{primary_mount}' is not a mounted filesystem. "
                f"Prepare and mount the drive first — see docs/installer.md "
                f"'USB Storage Setup'. Aborting.[/red]"
            )
            sys.exit(1)
        global PB_DATA_DIR, VIEWER_CACHE
        PB_DATA_DIR = f"{primary_mount}/pocketbase"
        VIEWER_CACHE = f"{primary_mount}/frame-viewer-cache"

    # Question 8: Automatic PocketBase backups (built into PocketBase 0.25 —
    # no custom backup scripting needed). Only offered for a locally-run PB.
    backup_enabled = False
    backup_cron = ""
    backup_cron_max_keep = 0
    backup_mount = ""
    if pb_on_pi:
        backup_enabled = ask_yes_no("Configure automatic PocketBase backups?", default=False)
        if backup_enabled:
            backup_freq = ask_value("Backup frequency (daily/weekly)", default="daily")
            freq_map = {
                "daily": ("0 3 * * *", 7),
                "weekly": ("0 3 * * 0", 4),
            }
            if backup_freq not in freq_map:
                step_warn(f"Unrecognized frequency '{backup_freq}' — defaulting to daily")
                backup_freq = "daily"
            backup_cron, backup_cron_max_keep = freq_map[backup_freq]

            backup_mount = pick_mount("backup storage")
            if backup_mount:
                if not is_mountpoint(backup_mount):
                    console.print(
                        f"[red]ERROR: '{backup_mount}' is not a mounted filesystem. "
                        f"Prepare and mount the drive first — see docs/installer.md "
                        f"'USB Storage Setup'. Aborting.[/red]"
                    )
                    sys.exit(1)

    # Questions 9–12: Viewer config
    device_id = ask_value("Device ID (leave blank to auto-create)", default="")
    device_key = ask_value("Device API key (leave blank to auto-create)", default="")
    interval_ms = int(ask_value("Slide interval (ms)", default="8000"))
    transition = ask_value("Transition effect (fade/crossfade/cut)", default="fade")

    console.print()
    console.print("[green]Configuration complete.[/green] Installation starting…")
    console.print()

    # ────────────────────────────────────────────────────────────────────────
    console.print(Rule("[bold]Phase 2 — Repository[/bold]"))
    console.print()

    script_dir = Path(__file__).resolve().parent
    repo_root = (script_dir / "..").resolve()

    if not (repo_root / "admin" / "package.json").exists() or not (repo_root / "viewer").is_dir():
        console.print(f"Project files not found next to script. Cloning to [cyan]{INSTALL_DIR}[/cyan]…")
        install_path = Path(INSTALL_DIR)
        if install_path.exists():
            backup = f"{INSTALL_DIR}.backup.{int(time.time())}"
            step_warn(f"Existing installation found — backing up to {backup}")
            install_path.rename(backup)
        if shutil.which("git"):
            with Status("Cloning repository…", console=console):
                run(["git", "clone", "--depth=1", "--branch", REPO_BRANCH, REPO_URL, INSTALL_DIR])
        else:
            tarball = Path("/tmp/spomienka-repo.tar.gz")
            url = f"{REPO_URL.removesuffix('.git')}/archive/refs/heads/{REPO_BRANCH}.tar.gz"
            download_file(url, tarball)
            install_path.mkdir(parents=True, exist_ok=True)
            run(["tar", "-xzf", str(tarball), "-C", "/tmp"])
            for item in Path("/tmp").glob("spomienka-*"):
                if item.is_dir():
                    for child in item.iterdir():
                        shutil.move(str(child), INSTALL_DIR)
                    break
        repo_root = Path(INSTALL_DIR)
        step_ok(f"Repository ready at {INSTALL_DIR}")
    elif str(repo_root) != INSTALL_DIR:
        console.print(f"Copying project to [cyan]{INSTALL_DIR}[/cyan]…")
        install_path = Path(INSTALL_DIR)
        if install_path.exists():
            backup = f"{INSTALL_DIR}.backup.{int(time.time())}"
            step_warn(f"Existing installation found — backing up to {backup}")
            install_path.rename(backup)
        with Status("Copying…", console=console):
            shutil.copytree(str(repo_root), INSTALL_DIR)
        repo_root = Path(INSTALL_DIR)
        step_ok(f"Project copied to {INSTALL_DIR}")
    else:
        step_ok(f"Running from install directory: {INSTALL_DIR}")

    schema_path = str(repo_root / "backend" / "pb_schema.json")

    # ────────────────────────────────────────────────────────────────────────
    console.print()
    console.print(Rule("[bold]Phase 3 — System Dependencies[/bold]"))
    console.print()

    apt_packages = [
        "git", "build-essential", "pkg-config", "cmake", "libssl-dev", "libudev-dev",
        "libasound2-dev", "libxcb-shape0-dev", "libxcb-xfixes0-dev",
        "libsdl2-dev", "libsdl2-image-dev", "libsdl2-ttf-dev",
        "ffmpeg", "libgstreamer1.0-dev", "libgstreamer-plugins-base1.0-dev",
        "gstreamer1.0-plugins-base", "gstreamer1.0-libav", "gstreamer1.0-plugins-good", "gstreamer1.0-plugins-bad",
        "gstreamer1.0-plugins-ugly", "gstreamer1.0-alsa", "gstreamer1.0-tools",
        "exiftool", "curl", "unzip", "at", "expect",
        "libheif-examples",
    ]

    with Status("Running apt update & upgrade…", console=console):
        run(["sudo", "apt", "update"])
        run(["sudo", "apt", "upgrade", "-y"])

    with Status(f"Installing {len(apt_packages)} apt packages…", console=console):
        run(["sudo", "apt", "install", "-y"] + apt_packages)
    step_ok("System packages installed")

    with Status("Configuring GL Full KMS driver…", console=console):
        result = run(["sudo", "raspi-config", "nonint", "do_gldriver", "G2"], check=False)
    if result.returncode == 0:
        step_ok("GL Full KMS driver set")
    else:
        step_warn("Could not set GL driver automatically — configure via raspi-config later")

    # ────────────────────────────────────────────────────────────────────────
    console.print()
    console.print(Rule("[bold]Phase 4 — Rust Toolchain[/bold]"))
    console.print()

    if shutil.which("rustup"):
        with Status("Updating Rust stable…", console=console):
            run(["rustup", "update", "stable"])
        step_ok("Rust updated")
    else:
        with Status("Installing rustup…", console=console):
            run_shell(
                'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
            )
        cargo_bin = str(Path.home() / ".cargo" / "bin")
        os.environ["PATH"] = f"{cargo_bin}:{os.environ.get('PATH', '')}"
        step_ok("Rust installed")

    if add_cross_target:
        with Status("Adding aarch64-unknown-linux-gnu target…", console=console):
            run(["rustup", "target", "add", "aarch64-unknown-linux-gnu"], check=False)
        step_ok("Cross target added")

    # ────────────────────────────────────────────────────────────────────────
    pb_superuser_email = ""
    pb_superuser_password = ""
    frame_admin_email = ""
    frame_admin_password = ""
    admin_created = False

    if pb_on_pi:
        console.print()
        console.print(Rule("[bold]Phase 5 — PocketBase[/bold]"))
        console.print()

        pb_host_external = PB_HOST_INTERNAL

        # Directories
        with Status("Creating PocketBase directories…", console=console):
            run(["sudo", "mkdir", "-p", "/opt/pocketbase", PB_DATA_DIR])
            run(["sudo", "chown", f"{os.environ['USER']}:{os.environ['USER']}", "/opt/pocketbase", PB_DATA_DIR])
            run(["sudo", "mkdir", "-p", f"{PB_DATA_DIR}/pb_migrations"])
            run(["sudo", "chown", f"{os.environ['USER']}:{os.environ['USER']}", f"{PB_DATA_DIR}/pb_migrations"])
        step_ok("Directories ready")

        # Redirect PocketBase's built-in backups to the separate backup
        # drive, if one was configured, via a symlink (ln -sfn is idempotent
        # across reinstalls).
        if backup_enabled and backup_mount:
            with Status("Linking backup storage…", console=console):
                run(["sudo", "mkdir", "-p", f"{backup_mount}/pocketbase-backups"])
                run(["sudo", "chown", f"{os.environ['USER']}:{os.environ['USER']}", f"{backup_mount}/pocketbase-backups"])
                run(["ln", "-sfn", f"{backup_mount}/pocketbase-backups", f"{PB_DATA_DIR}/backups"])
            step_ok(f"Backups linked to {backup_mount}/pocketbase-backups")

        # Download PocketBase
        pb_arch = PB_ARCH_MAP.get(arch)
        if not pb_arch:
            console.print(f"[red]ERROR: No PocketBase release available for architecture '{arch}'. Aborting.[/red]")
            sys.exit(1)
        pb_zip = Path("/tmp/pb.zip")
        pb_url = f"https://github.com/pocketbase/pocketbase/releases/download/v{PB_VERSION}/pocketbase_{PB_VERSION}_linux_{pb_arch}.zip"
        console.print(f"  Downloading PocketBase v{PB_VERSION}…")
        download_file(pb_url, pb_zip)
        run(["unzip", "-o", str(pb_zip), "-d", "/opt/pocketbase"])
        run(["sudo", "chmod", "+x", PB_BIN_PATH])
        step_ok(f"PocketBase v{PB_VERSION} installed to /opt/pocketbase")

        # Schema file
        if not Path(schema_path).exists():
            console.print(f"[red]ERROR: backend/pb_schema.json not found at {schema_path}[/red]")
            sys.exit(1)
        step_ok("Schema file found")

        # Install hooks
        hooks_src = repo_root / "backend" / "pb_hooks"
        if hooks_src.is_dir():
            with Status("Installing PocketBase hooks…", console=console):
                run(["sudo", "mkdir", "-p", f"{PB_DATA_DIR}/pb_hooks"])
                run_shell(f"sudo cp -r {hooks_src}/* {PB_DATA_DIR}/pb_hooks/")
                run(["sudo", "chown", "-R", f"{os.environ['USER']}:{os.environ['USER']}", f"{PB_DATA_DIR}/pb_hooks"])
            step_ok("Hooks installed")
        else:
            step_warn("backend/pb_hooks not found — skipping hooks installation")

        # Create superuser (CLI, works on DB directly before service starts)
        pb_superuser_email = "superuser@frame.local"
        pb_superuser_password = generate_password()
        with Status("Creating PocketBase superuser…", console=console):
            ok = create_superuser(pb_superuser_email, pb_superuser_password)
        if ok:
            step_ok("PocketBase superuser created")
        else:
            step_warn("Superuser creation failed — admin user creation will be skipped")

        # Systemd service (TLS terminated by Caddy, PocketBase always on plain HTTP)
        pb_mounts = []
        for m in (primary_mount, backup_mount if backup_enabled else ""):
            if m and m not in pb_mounts:
                pb_mounts.append(m)
        pb_requires_mounts = f"\nRequiresMountsFor={' '.join(pb_mounts)}" if pb_mounts else ""
        service_content = f"""[Unit]
Description=PocketBase
After=network-online.target
Wants=network-online.target{pb_requires_mounts}

[Service]
ExecStart={PB_BIN_PATH} serve --http=0.0.0.0:{PB_PORT_DEFAULT} --dir {PB_DATA_DIR} --migrationsDir {PB_DATA_DIR}/pb_migrations --hooksDir {PB_DATA_DIR}/pb_hooks
WorkingDirectory=/opt/pocketbase
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5
User={os.environ['USER']}

[Install]
WantedBy=multi-user.target
"""
        Path("/tmp/pocketbase.service").write_text(service_content)
        run(["sudo", "mv", "/tmp/pocketbase.service", "/etc/systemd/system/pocketbase.service"])
        run(["sudo", "systemctl", "daemon-reload"])
        run(["sudo", "systemctl", "enable", "--now", "pocketbase"])
        step_ok("PocketBase systemd service enabled and started")

        import socket as _socket
        try:
            _lan_ip = _socket.gethostbyname(_socket.gethostname())
        except Exception:
            _lan_ip = "localhost"
        pb_host_external = f"http://{_lan_ip}:{PB_PORT_DEFAULT}"

        # Wait for PocketBase to be ready
        console.print()
        with Status("Waiting for PocketBase to be ready…", console=console):
            pb_ready = wait_for_pocketbase(f"http://localhost:{PB_PORT_DEFAULT}")

        if pb_ready:
            step_ok("PocketBase is ready")

            if backup_enabled:
                console.print()
                console.print(Rule("[bold]Phase 5a — Backup Configuration[/bold]"))
                console.print()

                token = get_superuser_token(
                    f"http://localhost:{PB_PORT_DEFAULT}", pb_superuser_email, pb_superuser_password
                )
                if token:
                    resp = api_patch(
                        f"http://localhost:{PB_PORT_DEFAULT}/api/settings",
                        {"backups": {"cron": backup_cron, "cronMaxKeep": backup_cron_max_keep}},
                        token,
                    )
                    if "_error" in resp:
                        step_warn(f"Failed to configure automatic backups: {resp['_error']}")
                    else:
                        step_ok(f"Automatic backups scheduled ({backup_cron}, keeping {backup_cron_max_keep})")
                else:
                    step_warn("Could not authenticate as superuser — automatic backups not configured")

            console.print()
            console.print(Rule("[bold]Phase 5b — Schema Import[/bold]"))
            console.print()

            schema_ok = import_schema_via_api(
                f"http://localhost:{PB_PORT_DEFAULT}",
                pb_superuser_email,
                pb_superuser_password,
                schema_path,
            )

            if schema_ok:
                step_ok("Schema imported successfully")

                console.print()
                console.print(Rule("[bold]Phase 5c — Frame Admin User[/bold]"))
                console.print()

                frame_admin_email = "admin@frame.local"
                frame_admin_password = generate_password()

                create_result = create_admin_user(
                    f"http://localhost:{PB_PORT_DEFAULT}",
                    frame_admin_email,
                    frame_admin_password,
                    pb_superuser_email,
                    pb_superuser_password,
                )
                if create_result == 0:
                    admin_created = True
                    step_ok(f"Frame admin user created: {frame_admin_email}")
                elif create_result == 2:
                    frame_admin_email = "(existing admin — check PocketBase)"
                    frame_admin_password = "(not changed)"
                    step_warn("Admin user already exists — skipping creation")
                else:
                    frame_admin_email = "(MANUAL CREATION REQUIRED)"
                    frame_admin_password = "(create via PocketBase admin UI)"
                    step_fail("Failed to create frame admin user — create manually via PocketBase UI")

                # Auto-create local device if none supplied
                if not device_id and not device_key:
                    console.print()
                    with Status("Creating local device…", console=console):
                        device_id, device_key = create_local_device(
                            f"http://localhost:{PB_PORT_DEFAULT}",
                            pb_superuser_email,
                            pb_superuser_password,
                            "local-frame-1",
                            interval_ms,
                            transition,
                        )
                    if device_id:
                        step_ok(f"Local device created (ID: {device_id})")
                    else:
                        step_warn("Failed to auto-create local device — create one via Admin Settings")
            else:
                frame_admin_email = "(MANUAL CREATION REQUIRED — import schema first)"
                frame_admin_password = "(create via PocketBase admin UI after schema import)"
                step_fail("Schema import failed — admin user creation skipped")
        else:
            frame_admin_email = "(MANUAL CREATION REQUIRED)"
            frame_admin_password = "(create via PocketBase admin UI)"
            step_fail("PocketBase did not respond in time — admin user not created")

    # ────────────────────────────────────────────────────────────────────────
    if admin_local:
        console.print()
        console.print(Rule("[bold]Phase 6 — Admin UI[/bold]"))
        console.print()

        if not shutil.which("node"):
            with Status("Installing Node.js 20 via NodeSource…", console=console):
                run_shell("curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -")
                run(["sudo", "apt", "install", "-y", "nodejs"])
            step_ok("Node.js installed")

        with Status("Installing 'serve' globally…", console=console):
            run(["sudo", "npm", "install", "-g", "serve"])
        step_ok("serve installed")

        # When Caddy is enabled the SPA is served from the same origin as the API,
        # so we use the external HTTPS URL. Without TLS, use the internal HTTP URL.
        vite_pb_url = pb_host_external if (enable_tls and pb_on_pi) else f"http://localhost:{PB_PORT_DEFAULT}" if pb_on_pi else pb_host_external
        console.print(f"  Building admin SPA with [cyan]VITE_PB_URL={vite_pb_url}[/cyan]…")
        with Status("npm install…", console=console):
            run(["npm", "install"], cwd=str(repo_root / "admin"))
        with Status("npm run build…", console=console):
            run(["npm", "run", "build"], cwd=str(repo_root / "admin"),
                env={"VITE_PB_URL": vite_pb_url})
        step_ok("Admin SPA built")

        serve_path = shutil.which("serve") or "/usr/local/bin/serve"
        admin_service = f"""[Unit]
Description=Frame Admin UI
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory={INSTALL_DIR}/admin
ExecStart={serve_path} -s dist -l {admin_port}
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5
User={os.environ['USER']}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
"""
        Path("/tmp/frame-admin.service").write_text(admin_service)
        run(["sudo", "mv", "/tmp/frame-admin.service", "/etc/systemd/system/frame-admin.service"])
        run(["sudo", "systemctl", "daemon-reload"])
        run(["sudo", "systemctl", "enable", "--now", "frame-admin"])
        step_ok(f"Admin UI service enabled on port {admin_port}")
    else:
        step_warn("Skipping local Admin UI. To deploy elsewhere:")
        console.print(f"  [dim]cd admin && npm install && npm run build[/dim]")
        console.print(f"  [dim]Host ./dist with VITE_PB_URL={pb_host_external}[/dim]")

    # ────────────────────────────────────────────────────────────────────────
    console.print()
    console.print(Rule("[bold]Phase 7 — Viewer Build[/bold]"))
    console.print()

    # cargo build --release compiles several native/bindgen-heavy crates
    # (sdl2-sys, gstreamer-video-sys, ring via rustls-tls) — on a 4GB Pi 4
    # running with the default job count (one per core) this can OOM or
    # swap-thrash. Temporarily grow swap and cap build parallelism.
    swapfile_conf = Path("/etc/dphys-swapfile")
    original_swapsize: Optional[str] = None
    swap_available = shutil.which("dphys-swapfile") is not None and swapfile_conf.exists()

    if swap_available:
        with Status("Growing swap for the build (dphys-swapfile)…", console=console):
            conf_text = run(["sudo", "cat", str(swapfile_conf)], capture=True).stdout
            for line in conf_text.splitlines():
                if line.startswith("CONF_SWAPSIZE="):
                    original_swapsize = line.split("=", 1)[1].strip()
                    break
            run(["sudo", "sed", "-i",
                 "s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/",
                 str(swapfile_conf)])
            run(["sudo", "dphys-swapfile", "swapoff"], check=False)
            run(["sudo", "dphys-swapfile", "setup"], check=False)
            run(["sudo", "dphys-swapfile", "swapon"], check=False)
        step_ok("Swap temporarily increased to 2048MB for the build")
    else:
        step_warn("dphys-swapfile not found — skipping temporary swap increase")

    try:
        with Status("cargo build --release (this may take 15–25 min with limited parallelism)…", console=console):
            run(["cargo", "build", "--release", "--jobs", "2"], cwd=str(repo_root / "viewer"))
        step_ok("Viewer built")
    finally:
        if swap_available:
            with Status("Restoring original swap size…", console=console):
                restore_size = original_swapsize or "100"
                run(["sudo", "sed", "-i",
                     f"s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE={restore_size}/",
                     str(swapfile_conf)])
                run(["sudo", "dphys-swapfile", "swapoff"], check=False)
                run(["sudo", "dphys-swapfile", "setup"], check=False)
                run(["sudo", "dphys-swapfile", "swapon"], check=False)
            step_ok(f"Swap restored to {restore_size}MB")

    run(["sudo", "install", "-m", "0755",
         str(repo_root / "viewer" / "target" / "release" / VIEWER_BIN_NAME),
         f"/usr/local/bin/{VIEWER_BIN_NAME}"])
    step_ok(f"Viewer installed to /usr/local/bin/{VIEWER_BIN_NAME}")

    # ────────────────────────────────────────────────────────────────────────
    if enable_tls and pb_on_pi:
        console.print()
        console.print(Rule("[bold]Phase 8 — HTTPS / Caddy[/bold]"))
        console.print()

        with Status("Installing Caddy…", console=console):
            # Official Caddy apt repo
            run_shell(
                'curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key"'
                ' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg'
            )
            run_shell(
                'curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt"'
                ' | sudo tee /etc/apt/sources.list.d/caddy-stable.list'
            )
            run(["sudo", "apt", "update"])
            run(["sudo", "apt", "install", "-y", "caddy"])
        step_ok("Caddy installed")

        # Build Caddyfile — proxy PB API + optional Admin SPA on port 443
        if admin_local:
            caddyfile = f""":443 {{
    tls internal

    handle /api/* {{
        reverse_proxy localhost:{PB_PORT_DEFAULT}
    }}
    handle /_/* {{
        reverse_proxy localhost:{PB_PORT_DEFAULT}
    }}
    handle {{
        reverse_proxy localhost:{admin_port}
    }}
}}

:80 {{
    redir https://{{host}}{{uri}} permanent
}}
"""
        else:
            caddyfile = f""":443 {{
    tls internal
    reverse_proxy localhost:{PB_PORT_DEFAULT}
}}

:80 {{
    redir https://{{host}}{{uri}} permanent
}}
"""
        Path("/tmp/Caddyfile").write_text(caddyfile)
        run(["sudo", "mv", "/tmp/Caddyfile", "/etc/caddy/Caddyfile"])
        run(["sudo", "systemctl", "reload-or-restart", "caddy"])
        step_ok("Caddy configured and running (tls internal — self-signed LAN cert)")

        # Update the external URL to HTTPS now that Caddy is in front
        import socket as _socket2
        try:
            _lan_ip2 = _socket2.gethostbyname(_socket2.gethostname())
        except Exception:
            _lan_ip2 = _lan_ip
        pb_host_external = f"https://{_lan_ip2}"
        step_ok(f"External URL updated to {pb_host_external}")

        console.print()
        console.print("  [dim]Note: browsers will show a certificate warning on first visit.[/dim]")
        console.print("  [dim]Install the Caddy local CA cert to trust it: https://caddyserver.com/docs/automatic-https#local-https[/dim]")

    # ────────────────────────────────────────────────────────────────────────
    console.print()
    console.print(Rule("[bold]Phase 9 — Configuration & Services[/bold]"))
    console.print()

    # Viewer config
    run(["sudo", "mkdir", "-p", str(Path(VIEWER_CONFIG).parent), VIEWER_CACHE])
    run(["sudo", "chown", f"{os.environ['USER']}:{os.environ['USER']}",
         str(Path(VIEWER_CONFIG).parent), VIEWER_CACHE])

    viewer_config_content = f"""pb_url = "http://localhost:{PB_PORT_DEFAULT}"
interval_ms = {interval_ms}
transition = "{transition}"
cache_dir = "{VIEWER_CACHE}"
device_id = "{device_id}"
device_api_key = "{device_key}"
"""
    Path("/tmp/frame-viewer-config.toml").write_text(viewer_config_content)
    run(["sudo", "mv", "/tmp/frame-viewer-config.toml", VIEWER_CONFIG])
    step_ok(f"Viewer config written to {VIEWER_CONFIG}")

    cred_content = f"AUTH_EMAIL={frame_admin_email}\nAUTH_PASSWORD={frame_admin_password}\n"
    Path("/tmp/viewer-credentials").write_text(cred_content)
    run(["sudo", "install", "-D", "-m", "0600", "-o", os.environ['USER'],
         "/tmp/viewer-credentials", "/etc/spomienka/viewer-credentials"])
    Path("/tmp/viewer-credentials").unlink(missing_ok=True)
    step_ok("Viewer credentials written to /etc/spomienka/viewer-credentials (mode 0600)")

    # Headless/Lite kiosk boot: no desktop session owns the display, so the
    # viewer targets KMSDRM directly and starts on multi-user.target rather
    # than graphical.target (which Lite installs may never reach).
    viewer_after = "network-online.target"
    if pb_on_pi:
        viewer_after += " pocketbase.service"

    viewer_requires_mounts = f"\nRequiresMountsFor={primary_mount}" if primary_mount else ""

    viewer_service = f"""[Unit]
Description=Frame Viewer
After={viewer_after}
Wants=network-online.target{viewer_requires_mounts}

[Service]
Environment=RUST_LOG=info
Environment=SDL_VIDEODRIVER=kmsdrm
EnvironmentFile=/etc/spomienka/viewer-credentials
ExecStart=/usr/local/bin/{VIEWER_BIN_NAME}
WorkingDirectory={Path.home()}
SupplementaryGroups=video render input
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5
User={os.environ['USER']}

[Install]
WantedBy=multi-user.target
"""
    Path("/tmp/frame-viewer.service").write_text(viewer_service)
    run(["sudo", "mv", "/tmp/frame-viewer.service", "/etc/systemd/system/frame-viewer.service"])
    run(["sudo", "systemctl", "daemon-reload"])
    run(["sudo", "systemctl", "enable", "--now", "frame-viewer"])
    run(["sudo", "systemctl", "restart", "frame-viewer"])
    step_ok("Viewer systemd service enabled and started")

    # ────────────────────────────────────────────────────────────────────────
    console.print()
    console.print(Rule("[bold]Phase 10 — Summary[/bold]"))
    console.print()

    pb_location = "local on this Pi" if pb_on_pi else "remote"
    admin_mode = f"local on this Pi (port {admin_port})" if admin_local else "not installed (deploy elsewhere)"
    tls_mode = "Caddy (tls internal — self-signed)" if (enable_tls and pb_on_pi) else "none (HTTP)"
    primary_storage_mode = f"USB/external drive ({primary_mount})" if primary_mount else "SD card (default)"
    if backup_enabled:
        backup_mode = f"{backup_freq}, {backup_mount or PB_DATA_DIR + '/backups'}"
    else:
        backup_mode = "not configured"

    summary_table = Table(show_header=False, box=None, padding=(0, 1))
    summary_table.add_column("Key", style="bold", no_wrap=True)
    summary_table.add_column("Value")

    summary_table.add_row("Install dir", INSTALL_DIR)
    summary_table.add_row("PocketBase", pb_location)
    summary_table.add_row("PocketBase URL (LAN)", pb_host_external)
    summary_table.add_row("PocketBase data dir", PB_DATA_DIR)
    summary_table.add_row("Primary storage", primary_storage_mode)
    summary_table.add_row("Backups", backup_mode)
    summary_table.add_row("HTTPS / TLS", tls_mode)
    summary_table.add_row("Admin UI", admin_mode)
    summary_table.add_row("Viewer binary", f"/usr/local/bin/{VIEWER_BIN_NAME}")
    summary_table.add_row("Viewer config", VIEWER_CONFIG)
    summary_table.add_row("Viewer cache", VIEWER_CACHE)
    summary_table.add_row("Device ID", device_id or "(none)")
    summary_table.add_row("Device key", device_key or "(none)")

    console.print(Panel(summary_table, title="Installation Details", border_style="green"))
    console.print()

    if pb_superuser_email:
        cred_table = Table(show_header=False, box=None, padding=(0, 1))
        cred_table.add_column("Key", style="bold", no_wrap=True)
        cred_table.add_column("Value", style="yellow")

        cred_table.add_row("[dim]PocketBase Superuser[/dim]", "")
        cred_table.add_row("  Email", pb_superuser_email)
        cred_table.add_row("  Password", pb_superuser_password)
        cred_table.add_row("", "")
        cred_table.add_row("[dim]Frame Admin User[/dim]", "")
        cred_table.add_row("  Email", frame_admin_email)
        cred_table.add_row("  Password", frame_admin_password)
        if admin_created:
            cred_table.add_row("  Status", "[green]CREATED — save these now![/green]")
        else:
            cred_table.add_row("  Status", "[yellow]see notes above[/yellow]")

        console.print(Panel(
            cred_table,
            title="[bold red]⚠  Credentials — Save Before This Window Closes  ⚠[/bold red]",
            border_style="red",
        ))
        console.print()

    # Write summary file
    summary_file = Path.home() / "spomienka-install-summary.txt"
    summary_file.write_text(
        f"=== Spomienka Install Summary ===\n\n"
        f"Install dir: {INSTALL_DIR}\n"
        f"PocketBase: {pb_location}\n"
        f"PocketBase URL: {pb_host_external}\n"
        f"Primary storage: {primary_storage_mode}\n"
        f"Backups: {backup_mode}\n"
        f"Admin UI: {admin_mode}\n"
        f"Viewer: /usr/local/bin/{VIEWER_BIN_NAME}\n"
        f"Config: {VIEWER_CONFIG}\n"
        f"Device ID: {device_id or '(none)'}\n"
        f"Device key: {device_key or '(none)'}\n\n"
        f"PocketBase Superuser:\n"
        f"  Email:    {pb_superuser_email or '(not created)'}\n"
        f"  Password: {pb_superuser_password or '(not created)'}\n\n"
        f"Frame Admin User:\n"
        f"  Email:    {frame_admin_email or '(not created)'}\n"
        f"  Password: {frame_admin_password or '(not created)'}\n\n"
        f"*** SECURITY NOTICE ***\n"
        f"This file contains credentials and will be deleted automatically in 24 hours.\n"
        f"Save them to a password manager NOW.\n"
    )

    # Schedule deletion
    if shutil.which("at"):
        run(["sudo", "systemctl", "enable", "--now", "atd"], check=False)
        run_shell(f"echo \"rm -f '{summary_file}'\" | at now + 24 hours", check=False)
        step_ok(f"Summary saved to {summary_file} (auto-deletes in 24h)")
    else:
        step_warn(f"Summary saved to {summary_file} — delete manually after saving credentials")

    console.print()
    console.print(Panel(
        "[green bold]Installation complete![/green bold]\n\n"
        "If the GL driver was changed, a reboot is recommended.\n"
        "[dim]Check service logs: journalctl -u frame-viewer -f[/dim]",
        border_style="green",
        padding=(1, 2),
    ))
    console.print()


if __name__ == "__main__":
    main()
