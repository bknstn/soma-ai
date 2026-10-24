#!/usr/bin/env bash
set -u

emit() {
  ok="$1"
  commit="$2"
  clean="$3"
  python_version="$4"
  cli_help="$5"
  skill_loaded="$6"
  error="$7"
  if [ -n "$error" ]; then
    error_json="\"$error\""
  else
    error_json=null
  fi
  printf '{"ok":%s,"provider":"hermes","source_commit":"%s","source_clean":%s,"python_version":"%s","cli_help":%s,"skill_loaded":%s,"error":%s}\n' \
    "$ok" "$commit" "$clean" "$python_version" "$cli_help" "$skill_loaded" "$error_json"
}

fail() {
  emit false "$source_revision" false "" false false "$1"
  exit 1
}

runtime_home_raw="${SOMA_RUNTIME_HOME:-}"
case "$runtime_home_raw" in
  /*) ;;
  *) source_revision=""; fail 'runtime_home_required' ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"
manifest="$script_dir/manifest.json"
if [ ! -f "$manifest" ]; then
  source_revision=""
  fail 'manifest_missing'
fi
source_path="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).source_path)' "$manifest" 2>/dev/null)"
source_revision="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).source_revision)' "$manifest" 2>/dev/null)"
runtime_dir_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.runtime_dir)' "$manifest" 2>/dev/null)"
hermes_home_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.hermes_home)' "$manifest" 2>/dev/null)"
user_home_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.user_home)' "$manifest" 2>/dev/null)"
python_file_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.python_file)' "$manifest" 2>/dev/null)"
working_directory_name="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtime.working_directory)' "$manifest" 2>/dev/null)"
[ -n "$source_revision" ] || fail 'manifest_invalid'

source_dir="$repo_root/$source_path"
[ ! -e "$source_dir/.env" ] && [ ! -L "$source_dir/.env" ] || fail 'source_env_present'
[ -d "$source_dir/.git" ] || [ -f "$source_dir/.git" ] || fail 'source_missing'
actual_revision="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)"
[ "$actual_revision" = "$source_revision" ] || fail 'source_revision_mismatch'
if ! source_status="$(git -C "$source_dir" status --porcelain --untracked-files=all 2>/dev/null)"; then
  fail 'source_status_failed'
fi
[ -z "$source_status" ] || fail 'source_dirty'

runtime_home="$(cd "$runtime_home_raw" 2>/dev/null && pwd -P)" || fail 'runtime_home_missing'
case "$runtime_home/" in
  "$repo_root/"*|"$source_dir/"*) fail 'runtime_home_overlaps_source' ;;
esac
managed_user_home="$runtime_home/$user_home_name"
working_directory="$runtime_home/$working_directory_name"
hermes_home="$runtime_home/$hermes_home_name"
hermes_runtime_dir="$runtime_home/$runtime_dir_name"
python_file="$runtime_home/$python_file_name"
[ -d "$managed_user_home" ] && [ -d "$working_directory" ] && [ -d "$hermes_home" ] && [ -d "$hermes_runtime_dir" ] || fail 'runtime_not_ready'
[ ! -L "$managed_user_home" ] && [ ! -L "$working_directory" ] && [ ! -L "$hermes_home" ] && [ ! -L "$hermes_runtime_dir" ] || fail 'runtime_directory_symlink'
[ -f "$hermes_home/SOUL.md" ] || fail 'persona_missing'
[ -f "$hermes_home/skills/soma-health/SKILL.md" ] || fail 'skill_missing'
[ -f "$python_file" ] || fail 'python_locator_missing'
if ! node --input-type=module -e '
  import fs from "node:fs";
  const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const valid = marker.schema_version === 1 && marker.managed_by === "soma-ai"
    && marker.runtime === "hermes" && marker.source_revision === process.argv[2]
    && ["setting_up", "ready"].includes(marker.setup_status)
    && typeof marker.created_at === "string" && typeof marker.updated_at === "string";
  process.exit(valid ? 0 : 1);
' "$runtime_home/.soma-runtime.json" "$source_revision" 2>/dev/null; then
  fail 'runtime_marker_invalid'
fi
IFS= read -r hermes_python < "$python_file" || fail 'python_locator_invalid'
case "$hermes_python" in
  "$hermes_runtime_dir"/python-*/bin/python3|"$hermes_runtime_dir"/python-*/bin/python3.14|"$hermes_runtime_dir"/python-*/python.exe) ;;
  *) fail 'python_path_outside_runtime' ;;
esac
[ -x "$hermes_python" ] || fail 'python_missing'

export SOMA_RUNTIME_HOME="$runtime_home"
export HOME="$managed_user_home"
export USERPROFILE="$managed_user_home"
export XDG_CONFIG_HOME="$managed_user_home/.config"
export XDG_DATA_HOME="$managed_user_home/.local/share"
export XDG_CACHE_HOME="$managed_user_home/.cache"
export HERMES_HOME="$hermes_home"
export HERMES_RUNTIME_DIR="$hermes_runtime_dir"
export HERMES_DISABLE_LAZY_INSTALLS=1
export PYTHONNOUSERSITE=1
unset PYTHONHOME PYTHONPATH VIRTUAL_ENV

python_output="$("$hermes_python" --version 2>/dev/null || true)"
case "$python_output" in
  'Python 3.14.'*) ;;
  *) fail 'python_version_unsupported' ;;
esac
python_version="${python_output#Python }"

if ! (cd "$source_dir" && "$hermes_python" "$source_dir/hermes" --help >/dev/null 2>&1); then
  emit false "$source_revision" true "$python_version" false false 'cli_help_failed'
  exit 1
fi
if ! skill_output="$(cd "$source_dir" && "$hermes_python" "$source_dir/hermes" skills list --source local 2>/dev/null)"; then
  emit false "$source_revision" true "$python_version" true false 'skill_list_failed'
  exit 1
fi
case "$skill_output" in
  *soma-health*) ;;
  *) emit false "$source_revision" true "$python_version" true false 'skill_not_loaded'; exit 1 ;;
esac

emit true "$source_revision" true "$python_version" true true ''
