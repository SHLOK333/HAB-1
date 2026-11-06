"""Find the two Heltecs on the hotspot and talk to them over TCP 2323.

Each node greets a new TCP client with "connected to <hostname>". mDNS names
(hab-beacon.local, hab-ground.local) are tried first; if the Mac cannot resolve
them, the hotspot subnet is scanned for port 2323.
"""
import ipaddress, socket, subprocess

PORT = 2323


def _hello(ip, timeout=1.5):
    try:
        s = socket.create_connection((ip, PORT), timeout=timeout)
        s.settimeout(timeout)
        line = s.recv(200).decode(errors="replace").strip()
        s.close()
        return line.replace("connected to ", "") if line.startswith("connected to ") else None
    except OSError:
        return None


def _subnet():
    out = subprocess.run(["ifconfig"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        parts = line.split()
        if parts[:1] == ["inet"] and parts[1].startswith("172.20.10."):
            return ipaddress.ip_network(parts[1] + "/28", strict=False)
    return ipaddress.ip_network("172.20.10.0/28")


def find(name):
    """Return the IP of hab-beacon or hab-ground, or None."""
    try:
        ip = socket.gethostbyname(name + ".local")
        if _hello(ip) == name:
            return ip
    except OSError:
        pass
    for host in _subnet().hosts():
        if _hello(str(host), timeout=0.6) == name:
            return str(host)
    return None


def connect(name_or_ip):
    ip = name_or_ip if name_or_ip[0].isdigit() else find(name_or_ip)
    if not ip:
        raise SystemExit(f"{name_or_ip} not found on the hotspot (is it powered and on Wi-Fi?)")
    s = socket.create_connection((ip, PORT), timeout=5)
    s.settimeout(None)
    return s, ip


def command(name_or_ip, cmd, wait_for=None, timeout=5.0):
    """Send one command line; return the first reply line containing wait_for (or None)."""
    s, _ = connect(name_or_ip)
    f = s.makefile("rw", encoding="utf-8", errors="replace", newline="\n")
    f.readline()                      # greeting
    f.write(cmd + "\n"); f.flush()
    if wait_for is None:
        s.close(); return None
    s.settimeout(timeout)
    try:
        for line in f:
            if wait_for in line:
                return line.strip()
    except OSError:
        return None
    finally:
        s.close()
