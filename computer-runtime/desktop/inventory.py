"""Inventory installed guest packages without network access or user home mounts."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess


def inventory():
    components = []
    rows = subprocess.check_output(
        ["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${Architecture}\n"],
        text=True, timeout=15,
    )
    for row in rows.splitlines():
        name, version, architecture = row.split("\t")
        notice = Path("/usr/share/doc") / name.split(":")[0] / "copyright"
        properties = [{"name": "dsbot:architecture", "value": architecture}]
        if notice.is_file():
            properties.extend([
                {"name": "dsbot:copyright-path", "value": str(notice)},
                {"name": "dsbot:copyright-sha256", "value": hashlib.sha256(notice.read_bytes()).hexdigest()},
            ])
        components.append({
            "type": "library", "group": "dpkg", "name": name,
            "version": version, "properties": properties,
        })
    for package in importlib.metadata.distributions():
        name = package.metadata.get("Name")
        if not name:
            continue
        properties = []
        for file in package.files or []:
            if file.name.lower() not in ("license", "license.txt", "copying", "notice"):
                continue
            path = Path(package.locate_file(file))
            if path.is_file():
                properties.append({"name": "dsbot:license-sha256", "value": hashlib.sha256(path.read_bytes()).hexdigest()})
        component = {
            "type": "library", "group": "python", "name": name,
            "version": package.version, "properties": properties,
        }
        declared = package.metadata.get("License-Expression") or package.metadata.get("License")
        if declared and len(declared) <= 300:
            component["licenses"] = [{"license": {"name": declared}}]
        components.append(component)
    return sorted(components, key=lambda item: (item["group"], item["name"], item["version"]))


if __name__ == "__main__":
    print(json.dumps(inventory()))
