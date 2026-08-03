# Quickstart: Set Up Your Spomienka Digital Frame (Complete Beginner Guide)

This guide walks you through turning a brand-new Raspberry Pi into a working
Spomienka digital picture frame, from an empty SD card to seeing your first
photo on screen. No prior Raspberry Pi or Linux experience needed — every
command is spelled out.

If you get stuck or want to go beyond the basics (HTTPS, USB storage detail,
remote hosting, updating), see the companion reference doc:
[docs/installer.md](installer.md).

## 1. What You'll Need

- A **Raspberry Pi 4** (4GB RAM or more recommended — an 8GB model is even
  smoother; a 2GB model works but needs an extra step, see
  [Resource Notes in installer.md](installer.md#resource-notes)).
- A **microSD card**, 16GB or larger.
- A **USB-C power supply** for the Pi.
- A **display** connected to the Pi via HDMI (this is what will show your
  photos).
- A **second computer** (Mac, Windows, or Linux) to prepare the SD card and
  connect to the Pi remotely.
- A **network** the Pi can join — Ethernet cable, or Wi-Fi.

You will *not* need a keyboard, mouse, or monitor plugged directly into the
Pi for setup — everything happens remotely from your other computer.

## 2. Flash the SD Card

1. On your other computer, download and install **Raspberry Pi Imager**:
   https://www.raspberrypi.com/software/
2. Insert the microSD card into your computer (using a USB adapter if
   needed) and open Raspberry Pi Imager.
3. Click **Choose Device** and select your Raspberry Pi model (e.g. "Raspberry Pi 4").
4. Click **Choose OS** → **Raspberry Pi OS (other)** → **Raspberry Pi OS Lite (64-bit)**.
   ("Lite" means no desktop — just the software needed to run the frame,
   which keeps things fast and simple.)
5. Click **Choose Storage** and select your SD card. Double-check you've
   picked the right device — this step erases everything on it.
6. Click the **gear icon** (or press Ctrl+Shift+X) to open advanced options
   *before* writing. This step matters a lot: it lets you connect to the Pi
   over the network afterward, without ever plugging in a keyboard or
   monitor to it directly. Set:
   - **Set hostname**: e.g. `spomienka` (you'll use this to connect later).
   - **Enable SSH**: choose "Use password authentication".
   - **Set username and password**: pick something memorable — you'll use
     these to log in.
   - **Configure wireless LAN**: fill in your Wi-Fi name and password if the
     Pi won't be on Ethernet.
7. Save the advanced options, then click **Write** and confirm. This takes a
   few minutes.

## 3. Boot the Pi and Connect

1. Once flashing finishes, put the microSD card in the Pi, plug in the
   HDMI cable to your display, then plug in the power supply.
2. Wait about 1–2 minutes for the first boot to finish.
3. Open a terminal on your other computer:
   - **Mac**: open the **Terminal** app (Cmd+Space, type "Terminal").
   - **Windows**: open **Windows Terminal** or **PowerShell** (search for
     it in the Start menu).
   - **Linux**: open your terminal application of choice.
4. Connect to the Pi over SSH (a secure remote-login protocol), replacing
   `<username>` and `<hostname>` with what you set in step 2:
   ```bash
   ssh <username>@<hostname>.local
   ```
   The first time you connect, you'll see a message about an unknown host
   key/fingerprint — type `yes` and press Enter. Then enter the password
   you set in Imager.

   **If `<hostname>.local` doesn't connect** (common on some Windows
   setups without Bonjour installed): find the Pi's IP address instead,
   either by checking your router's connected-devices page, or by running
   `arp -a` in your terminal and looking for the Pi. Then connect with:
   ```bash
   ssh <username>@<ip-address>
   ```

You're now controlling the Pi remotely from your terminal — everything from
here on happens in this SSH session.

## 4. (Optional) Set Up External Storage

If you want photos and the app's data stored on a USB drive instead of the
SD card — recommended for a permanent install, since it takes frequent
writes — plug it in and prepare it now. This is optional; for a first try,
feel free to skip it and use the SD card. See
[USB Storage Setup in installer.md](installer.md#usb-storage-setup-optional)
for the exact commands.

## 5. Download and Run the Installer

Run this single command. It downloads the installer script from GitHub and
runs it immediately with Python:

```bash
curl -fsSL https://raw.githubusercontent.com/jasonarmbrecht/spomienka/main/scripts/install_pi.py | python3
```

The installer will ask you a series of yes/no and fill-in-the-blank
questions before it does anything — nothing is installed until you've
answered all of them.

## 6. Answer the Prompts

Here's what each question means, with a recommended answer for a first
install:

| Prompt | What it means | Recommended answer |
|---|---|---|
| Run PocketBase on this Pi? | PocketBase is the backend database/server that stores your photos and settings. | **Yes** |
| Serve Admin UI on this Pi? | The Admin UI is the web page you'll use to upload and manage photos. | **Yes** |
| Enable HTTPS/TLS? | Encrypts traffic to the Pi. Not needed for a home network. | **No** |
| Add aarch64-unknown-linux-gnu cross target? | A Rust build option, harmless either way. | **Yes** (default) |
| PocketBase data + viewer cache storage | Where to store data: leave blank for the SD card, or pick your USB drive if you prepared one in step 4. | **Blank**, unless you set up a drive |
| Configure automatic backups? | Automatically backs up your photo database on a schedule. | **Yes**, frequency **daily** |
| Device ID / Device API key | Leave blank — the installer creates these for you automatically. | **Blank** |
| Slide interval (ms) | How long each photo stays on screen, in milliseconds. | **8000** (default, 8 seconds) |
| Transition effect | The visual effect between photos. | **fade** (default) |

## 7. Let It Run

After the last prompt, installation proceeds automatically — no more
questions. This installs system packages, Rust, PocketBase, the Admin UI,
and builds the viewer app. On a 4GB Pi 4, expect this to take roughly
**15–25 minutes**, mostly spent building the viewer. Keep the terminal
window open and your SSH connection active until it finishes.

## 8. Save Your Credentials

When installation finishes, the installer prints login credentials for two
accounts:

- **PocketBase Superuser** — full database admin access.
- **Frame Admin user** — the account you'll use day-to-day in the Admin UI
  to upload and approve photos.

**Copy both sets of credentials somewhere safe right now** (a password
manager, a note — anywhere durable). They're also saved to
`~/spomienka-install-summary.txt` on the Pi, but that file **deletes itself
automatically after 24 hours**, so don't rely on it as permanent storage.

## 9. Reboot

The installer reboots the Pi automatically about 10 seconds after finishing
(this is required so a graphics driver setting takes effect). Your SSH
session will disconnect — that's expected. Wait about a minute, and the
frame should appear on the connected display.

## 10. Log Into the Admin UI

From your other computer (must be on the same network as the Pi), open a
web browser and go to:

```
http://<hostname>.local:4173
```

(replace `<hostname>` with what you set in step 2 — or use the LAN IP
address printed in the installer's summary if `.local` doesn't resolve).

Log in with the **Frame Admin** credentials from step 8, then:

1. Go to **Upload** and add a photo.
2. Go to **Approvals** and approve it.
3. Check your display — the photo should appear on the frame.

## 11. Verify Everything Is Running

If something doesn't look right, reconnect over SSH and check the three
services:

```bash
ssh <username>@<hostname>.local
sudo systemctl status pocketbase frame-admin frame-viewer
journalctl -u frame-viewer -f
```

(Press Ctrl+C to stop following the log.) For deeper troubleshooting steps,
see [Troubleshooting in installer.md](installer.md#troubleshooting).

## 12. What's Next

You now have a working frame. For anything beyond this golden path — HTTPS,
hosting the Admin UI elsewhere, detailed USB drive setup, cross-compiling
the viewer on a more powerful machine, or updating to a newer version — see
the full reference: [docs/installer.md](installer.md).
