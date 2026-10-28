#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'SOMA Hermes setup: %s\n' "$1" >&2
  exit 1
}

runtime_home_raw="${SOMA_RUNTIME_HOME:-}"
[ -n "$runtime_home_raw" ] || fail 'SOMA_RUNTIME_HOME must name an explicit managed runtime directory.'
case "$runtime_home_raw" in
  /*) ;;
  *) fail 'SOMA_RUNTIME_HOME must be an absolute path.' ;;
esac
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"
manifest="$script_dir/manifest.json"
[ -f "$manifest" ] || fail 'Runtime manifest is missing.'

source_path="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).source_path)' "$manifest")"
source_revision="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).source_revision)' "$manifest")"
python_min="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).bootstrap.minimum_python)' "$manifest")"
python_max="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).bootstrap.maximum_python_exclusive)' "$manifest")"
runtime_dir_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.runtime_dir)' "$manifest")"
hermes_home_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.hermes_home)' "$manifest")"
managed_dir_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.managed_dir)' "$manifest")"
user_home_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.user_home)' "$manifest")"
python_file_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.python_file)' "$manifest")"
uv_cache_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.uv_cache)' "$manifest")"
python_cache_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.python_cache)' "$manifest")"
working_directory_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.working_directory)' "$manifest")"
gateway_extra="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).gateway_dependencies.extra)' "$manifest")"
soul_template="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).assets.soul_template)' "$manifest")"
skill_source="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).assets.skill_source)' "$manifest")"
action_skill_source="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).assets.action_skill_source)' "$manifest")"

source_dir="$repo_root/$source_path"
[ -d "$source_dir/.git" ] || [ -f "$source_dir/.git" ] || fail 'Hermes submodule is not initialized.'
[ ! -e "$source_dir/.env" ] && [ ! -L "$source_dir/.env" ] || fail 'Refusing to run with a source-root .env file present.'
actual_revision="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)"
[ "$actual_revision" = "$source_revision" ] || fail 'Hermes source does not match the pinned revision.'
if ! source_status="$(git -C "$source_dir" status --porcelain --untracked-files=all 2>/dev/null)"; then
  fail 'Could not verify Hermes source status.'
fi
[ -z "$source_status" ] || fail 'Hermes source checkout has local changes.'

[ -d "$runtime_home_raw" ] || fail 'Runtime manager must create the managed runtime home first.'
runtime_home="$(cd "$runtime_home_raw" && pwd -P)"
case "$runtime_home/" in
  "$repo_root/"*|"$source_dir/"*) fail 'SOMA_RUNTIME_HOME must be outside the SOMA and Hermes source repositories.' ;;
esac
if ! node --input-type=module -e '
  import fs from "node:fs";
  const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const valid = marker.schema_version === 1 && marker.managed_by === "soma-ai"
    && marker.runtime === "hermes" && marker.source_revision === process.argv[2]
    && ["setting_up", "ready"].includes(marker.setup_status)
    && typeof marker.created_at === "string" && typeof marker.updated_at === "string";
  process.exit(valid ? 0 : 1);
' "$runtime_home/.soma-runtime.json" "$source_revision" 2>/dev/null; then
  fail 'A matching SOMA runtime manager marker is required before setup.'
fi

umask 077
managed_user_home="$runtime_home/$user_home_name"
hermes_home="$runtime_home/$hermes_home_name"
hermes_runtime_dir="$runtime_home/$runtime_dir_name"
uv_cache="$runtime_home/$uv_cache_name"
python_cache="$runtime_home/$python_cache_name"
working_directory="$runtime_home/$working_directory_name"
expected_managed_home="$runtime_home/$user_home_name"
expected_managed_config="$runtime_home/$managed_dir_name"
[ "${HOME:-}" = "$expected_managed_home" ] || fail 'The runtime manager must provide an isolated HOME under SOMA_RUNTIME_HOME.'
[ "${USERPROFILE:-}" = "$expected_managed_home" ] || fail 'The runtime manager must provide an isolated USERPROFILE under SOMA_RUNTIME_HOME.'
for managed_dir in "$managed_user_home" "$hermes_home" "$expected_managed_config" "$hermes_runtime_dir" "$uv_cache" "$python_cache" "$working_directory" "$runtime_home/python" "$runtime_home/python-bin"; do
  [ ! -L "$managed_dir" ] || fail 'Managed runtime paths must not be symlinks.'
done
for managed_skill_dir in "$hermes_home/skills" "$hermes_home/skills/soma-health" "$hermes_home/skills/soma-health-actions"; do
  [ ! -L "$managed_skill_dir" ] || fail 'Refusing to follow a symlink while installing the local Soma skill.'
done
mkdir -p "$managed_user_home" "$hermes_home" "$expected_managed_config" "$hermes_runtime_dir" "$uv_cache" "$python_cache" "$working_directory"
for managed_dir in "$managed_user_home" "$hermes_home" "$expected_managed_config" "$hermes_runtime_dir" "$uv_cache" "$python_cache" "$working_directory"; do
  managed_dir_physical="$(cd "$managed_dir" && pwd -P)"
  case "$managed_dir_physical/" in
    "$runtime_home/"*) ;;
    *) fail 'Managed runtime directories must remain inside SOMA_RUNTIME_HOME.' ;;
  esac
done

export SOMA_RUNTIME_HOME="$runtime_home"
export HOME="$managed_user_home"
export USERPROFILE="$managed_user_home"
export XDG_CONFIG_HOME="$managed_user_home/.config"
export XDG_DATA_HOME="$managed_user_home/.local/share"
export XDG_CACHE_HOME="$managed_user_home/.cache"
export HERMES_HOME="$hermes_home"
export HERMES_MANAGED_DIR="$expected_managed_config"
export HERMES_RUNTIME_DIR="$hermes_runtime_dir"
export UV_CACHE_DIR="$uv_cache"
export UV_PYTHON_CACHE_DIR="$python_cache"
export UV_PYTHON_INSTALL_DIR="$runtime_home/python"
export UV_PYTHON_BIN_DIR="$runtime_home/python-bin"
export UV_PYTHON_INSTALL_BIN=0
export UV_NO_CONFIG=1
export PYTHONNOUSERSITE=1
unset PYTHONHOME PYTHONPATH VIRTUAL_ENV

bootstrap_python="${SOMA_BOOTSTRAP_PYTHON:-}"
if [ -z "$bootstrap_python" ]; then
  if command -v python3 >/dev/null 2>&1; then
    bootstrap_python="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then
    bootstrap_python="$(command -v python)"
  else
    fail 'Python 3.11 or newer is required for the Hermes PM bootstrap.'
  fi
elif ! command -v "$bootstrap_python" >/dev/null 2>&1 && [ ! -x "$bootstrap_python" ]; then
  fail 'SOMA_BOOTSTRAP_PYTHON was not found or is not executable.'
fi

bootstrap_version="$("$bootstrap_python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
case "$bootstrap_version" in
  3.11|3.12|3.13|3.14) ;;
  *) fail "Bootstrap Python must be >=${python_min},<${python_max}." ;;
esac

printf 'Installing pinned Hermes tools and the minimal interactive CLI environment…\n' >&2
(cd "$source_dir" && "$bootstrap_python" -m pm.cli install uv) >&2

python_candidates=("$hermes_runtime_dir"/python-*/bin/python3.14 "$hermes_runtime_dir"/python-*/bin/python3 "$hermes_runtime_dir"/python-*/python.exe)
hermes_python=""
for candidate in "${python_candidates[@]}"; do
  [ -x "$candidate" ] || continue
  candidate_version="$("$candidate" --version 2>/dev/null || true)"
  case "$candidate_version" in
    'Python 3.14.'*) hermes_python="$candidate"; break ;;
  esac
done
[ -n "$hermes_python" ] || fail 'Pinned Python 3.14 was not installed by Hermes PM.'

printf 'Installing Hermes pinned tools without optional browser or CUA packages…\n' >&2
(cd "$source_dir" && "$hermes_python" -m pm.cli install --tools-only --without agent-browser --without cua-driver) >&2

printf 'Installing the minimal CLI dependencies through Hermes PM…\n' >&2
(cd "$source_dir" && "$hermes_python" -m pm.cli install --extra pty) >&2

printf 'Installing the pinned native Telegram gateway dependency through Hermes PM…\n' >&2
(cd "$source_dir" && "$hermes_python" -m pm.cli install --extra "$gateway_extra") >&2

python_file="$runtime_home/$python_file_name"
python_file_tmp=""
cleanup_python_locator() {
  if [ -n "$python_file_tmp" ]; then
    rm -f "$python_file_tmp"
  fi
}
trap cleanup_python_locator EXIT

python_file_tmp="$python_file.tmp.$$"
printf '%s\n' "$hermes_python" > "$python_file_tmp"
mv -f "$python_file_tmp" "$python_file"
python_file_tmp=""

seed_file_if_missing() {
  source_file="$1"
  destination_file="$2"
  [ -f "$source_file" ] || fail 'A runtime persona or skill source file is missing.'
  [ ! -L "$destination_file" ] || fail 'A managed persona or skill file must not be a symlink.'
  if [ ! -e "$destination_file" ] && [ ! -L "$destination_file" ]; then
    mkdir -p "$(dirname "$destination_file")"
    cp "$source_file" "$destination_file"
  fi
}

seed_file_if_missing "$repo_root/$soul_template" "$hermes_home/SOUL.md"
mkdir -p "$hermes_home/skills"
for skill_source in "$skill_source" "$action_skill_source"; do
  case "$skill_source" in skills/*) ;; *) fail 'A managed skill source path is invalid.' ;; esac
  case "$skill_source" in *..*) fail 'A managed skill source path is invalid.' ;; esac
  [ -d "$repo_root/$skill_source" ] && [ ! -L "$repo_root/$skill_source" ] || fail 'A managed skill source directory is invalid.'
  skill_name="$(basename "$skill_source")"
  skill_target="$hermes_home/skills/$skill_name"
  mkdir -p "$skill_target"
  [ ! -L "$skill_target" ] || fail 'A managed skill directory must not be a symlink.'
  for skill_file in "$repo_root/$skill_source"/*; do
    [ -f "$skill_file" ] || continue
    [ ! -L "$skill_file" ] || fail 'A managed skill source file must not be a symlink.'
    seed_file_if_missing "$skill_file" "$skill_target/$(basename "$skill_file")"
  done
done

for component in soma-continuity soma-progress soma-assistant; do
printf 'Installing opt-in SOMA component: %s…\n' "$component" >&2
(cd "$source_dir" && "$hermes_python" -B -c '
import hermes_bootstrap
import runpy
import sys
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
' "$script_dir/install-continuity.py" "$script_dir/plugins/$component" "$hermes_home") >&2
done

printf 'Installing the SOMA OpenAI web search plugin…\n' >&2
(cd "$source_dir" && "$hermes_python" -c '
import hermes_bootstrap
import runpy
import sys
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
' "$script_dir/install-web-search.py" "$script_dir/plugins/soma-openai-search" "$hermes_home") >&2

printf 'Hermes runtime setup completed under SOMA_RUNTIME_HOME.\n' >&2
