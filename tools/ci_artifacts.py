"""Validate versioned installers/update assets and prepare release checksums."""
import hashlib
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path('build/release-upload')


def version(root):
    value = json.loads((root / 'desktop/package.json').read_text())['version']
    lock = json.loads((root / 'desktop/package-lock.json').read_text())
    if lock['version'] != value or lock['packages']['']['version'] != value:
        raise ValueError('package.json and package-lock.json versions must agree.')
    return value


def verify(root, ref_type='', ref_name=''):
    value = version(root)
    if ref_type == 'tag' and ref_name != 'v' + value:
        raise ValueError(f'Tag {ref_name!r} must match desktop/package.json: v{value}')
    return value


def installer_name(platform, value):
    if platform == 'macos-arm64':
        return f'Meshkeep-{value}-arm64.dmg'
    if platform == 'windows-x64':
        return f'Meshkeep-{value}-Windows-x64-Setup.exe'
    raise ValueError('Unknown build platform: ' + platform)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            result.update(block)
    return result.hexdigest()


def required_names(platform, value):
    installer = installer_name(platform, value)
    if platform == 'macos-arm64':
        return [installer, f'Meshkeep-{value}-arm64.zip', 'latest-mac.yml']
    return [installer, 'latest.yml']


def optional_names(platform, value):
    return [name + '.blockmap' for name in required_names(platform, value)
            if not name.endswith('.yml')]


def collect(root, platform):
    value = version(root)
    folder = root / 'desktop' / ('dist' if platform == 'macos-arm64' else 'dist-win')
    names = required_names(platform, value)
    names += [name for name in optional_names(platform, value) if (folder / name).exists()]
    for name in names:
        source = folder / name
        if not source.is_file() or not source.stat().st_size:
            raise ValueError('Release asset missing or empty: ' + str(source))
    destination = root / OUTPUT
    destination.mkdir(parents=True, exist_ok=True)
    lines = []
    for name in names:
        source = folder / name
        shutil.copy2(source, destination / name)
        lines.append(f'{digest(source)}  {name}\n')
    (destination / f'SHA256SUMS-{platform}.txt').write_text(''.join(lines))
    return installer_name(platform, value)


def combine(root):
    value = version(root)
    folder = root / OUTPUT
    lines = []
    for platform in ['macos-arm64', 'windows-x64']:
        required = required_names(platform, value)
        allowed = set(required + optional_names(platform, value))
        seen = set()
        for line in (folder / f'SHA256SUMS-{platform}.txt').read_text().splitlines():
            checksum, name = line.split('  ', 1)
            if name not in allowed or name in seen:
                raise ValueError('Unexpected or duplicate release asset: ' + name)
            if not (folder / name).stat().st_size or digest(folder / name) != checksum:
                raise ValueError('Release asset checksum mismatch: ' + name)
            seen.add(name)
            lines.append(line + '\n')
        if not set(required).issubset(seen):
            raise ValueError('Missing installer or update metadata for ' + platform)
    (folder / 'SHA256SUMS.txt').write_text(''.join(lines))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['verify', 'collect', 'combine'])
    args = parser.parse_args()
    try:
        value = verify(ROOT, os.environ.get('GITHUB_REF_TYPE', ''), os.environ.get('GITHUB_REF_NAME', ''))
        if args.command == 'collect':
            print(collect(ROOT, os.environ['MME_CI_PLATFORM']))
        elif args.command == 'combine':
            combine(ROOT)
        else:
            print('Meshkeep version: ' + value)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, str(error) + '\n')
