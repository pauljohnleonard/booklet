#!/usr/bin/env bash
set -euo pipefail

# Mounting / destination defaults
APP="com.mgsdevelopment.forscore"
MOUNT_POINT="${MOUNT_POINT:-$HOME/mnt/ipad}"
DEST_DIR="${DEST_DIR:-$MOUNT_POINT}"
LOG_FILE="${LOG_FILE:-forscore_actions.jsonl}"
HASH_CACHE_FILE="${HASH_CACHE_FILE:-forscore_hashes.json}"

# Search pattern configuration (edit or supply via CLI)
DEFAULT_PATTERNS=(
	"/Users/paulleonard/Google Drive/My Drive/MUSIC/CircleDance/Tunes/**/*.pdf"
	"/Users/paulleonard/Google Drive/My Drive/MUSIC/BalFolkFrome/Third party/*.pdf"
	"/Users/paulleonard/Google Drive/My Drive/MUSIC/BalFolkFrome/TUNES/**/*.pdf"
	"/Users/paulleonard/Google Drive/My Drive/MUSIC/Victoria/**/*.pdf"
	"/Users/paulleonard/Google Drive/My Drive/MUSIC/Taize/**/*.pdf"
	"/Users/paulleonard/Google Drive/My Drive/MUSIC/FromeTaize/**/*.pdf"

)

DEFAULT_ACTION="prompt"
PATTERN_FILE=""
DRY_RUN=0
SKIP_MOUNT=0
REHASH_CACHE=0
declare -a EXTRA_PATTERNS=()
declare -a DEST_HASHES=()
declare -a DEST_PATHS=()

TOTAL_MATCHES=0
COUNT_COPIED=0
COUNT_OVERWRITTEN=0
COUNT_RENAMED=0
COUNT_SKIP_DUP_CONTENT=0
COUNT_SKIP_IDENTICAL=0
COUNT_SKIP_DIFF_CONTENT=0
COUNT_DUPES_DELETED=0

prompt_yes_no_default_no() {
	local prompt="$1" reply
	while true; do
		read -r -p "$prompt (y/N): " reply
		reply=${reply:-n}
		case "$reply" in
			Y|y) return 0 ;;
			N|n) return 1 ;;
			*) echo "Please answer y or n." ;;
		esac
	done
}

emit_hash_cache() {
	local idx
	for idx in "${!DEST_HASHES[@]}"; do
		printf '%s\t%s\n' "${DEST_HASHES[$idx]}" "${DEST_PATHS[$idx]}"
	done
}

remove_dest_entry() {
	local target="$1" idx
	local new_paths=() new_hashes=()
	for idx in "${!DEST_PATHS[@]}"; do
		if [[ "${DEST_PATHS[$idx]}" == "$target" ]]; then
			continue
		fi
		new_paths+=("${DEST_PATHS[$idx]}")
		new_hashes+=("${DEST_HASHES[$idx]}")
	done
	DEST_PATHS=("${new_paths[@]}")
	DEST_HASHES=("${new_hashes[@]}")
}

usage() {
	cat <<EOF
Usage: ${0##*/} [options]

Options:
	-d, --dest DIR           Destination folder inside the mounted forScore docs
	-l, --log FILE           JSON Lines log file (default: "$LOG_FILE")
	    --hash-cache FILE    Cache file for destination hashes (default: "$HASH_CACHE_FILE")
	-a, --always ACTION      Default conflict action: prompt|overwrite|skip|rename
	-f, --patterns-file FILE Newline-delimited glob patterns (supports # comments)
	-p, --pattern GLOB       Extra glob pattern (can be repeated)
	-n, --dry-run            Show planned actions without copying
	    --rehash-cache       Recompute all destination hashes (ignore cache file)
	    --skip-mount         Assume mount is ready; skip automatic ifuse call
	-h, --help               Show this help

Examples:
	${0##*/} -p "~/Downloads/**/*.pdf"
	${0##*/} --always overwrite --log logs/forscore.jsonl
EOF
}

require_python() {
	if ! command -v python3 >/dev/null 2>&1; then
		echo "python3 is required for glob expansion/logging" >&2
		exit 1
	fi
}

ensure_mount() {
	if mount | grep -q "${MOUNT_POINT}"; then
		return
	fi
	if (( SKIP_MOUNT )); then
		echo "Mount point ${MOUNT_POINT} is not mounted; rerun without --skip-mount" >&2
		exit 1
	fi
	if ! command -v ifuse >/dev/null 2>&1; then
		echo "ifuse is required to mount forScore documents" >&2
		exit 1
	fi
	mkdir -p "${MOUNT_POINT}"
	echo "Mounting forScore documents at ${MOUNT_POINT}..."
	ifuse --documents "${APP}" "${MOUNT_POINT}"
}

load_patterns() {
	local patterns=("${DEFAULT_PATTERNS[@]}")
	if [[ -n "${PATTERN_FILE}" ]]; then
		if [[ ! -f "${PATTERN_FILE}" ]]; then
			echo "Pattern file '${PATTERN_FILE}' not found" >&2
			exit 1
		fi
		while IFS= read -r line || [[ -n "$line" ]]; do
			[[ -z "$line" || "$line" =~ ^# ]] && continue
			patterns+=("$line")
		done < "${PATTERN_FILE}"
	fi
	if ((${#EXTRA_PATTERNS[@]})); then
		patterns+=("${EXTRA_PATTERNS[@]}")
	fi
	printf '%s\n' "${patterns[@]}"
}

expand_matches() {
	python3 - "$@" <<'PY'
import glob
import os
import sys

patterns = [os.path.expanduser(p) for p in sys.argv[1:]]
seen = set()
for pattern in patterns:
	for found in glob.glob(pattern, recursive=True):
		if not os.path.isfile(found):
			continue
		norm = os.path.normpath(found)
		if norm in seen:
			continue
		seen.add(norm)
		print(norm)
PY
}

log_action() {
	local action="$1" src="$2" dest="$3" note="${4:-}" file_hash="${5:-}"
	local log_dir
	log_dir=$(dirname "${LOG_FILE}")
	mkdir -p "${log_dir}"
	python3 - "$LOG_FILE" "$action" "$src" "$dest" "$note" "$file_hash" <<'PY'
import datetime
import json
import pathlib
import sys

log_file, action, src, dest, note, file_hash = sys.argv[1:]
entry = {
	"timestamp": datetime.datetime.now().isoformat(timespec="seconds"),
	"action": action,
	"source": src,
	"destination": dest,
	"note": note,
	"hash": file_hash or None,
}
pathlib.Path(log_file).parent.mkdir(parents=True, exist_ok=True)
with open(log_file, "a", encoding="utf-8") as fh:
	fh.write(json.dumps(entry) + "\n")
PY
}

hash_file() {
	python3 - "$1" <<'PY'
import hashlib
import sys

path = sys.argv[1]
h = hashlib.sha256()
try:
	with open(path, "rb") as fh:
		for chunk in iter(lambda: fh.read(1 << 20), b""):
			h.update(chunk)
except FileNotFoundError:
	print("", end="")
	sys.exit(1)
print(h.hexdigest())
PY
}


register_hash() {
	local path="$1" hash="$2" idx
	for idx in ${!DEST_PATHS[@]}; do
		if [[ "${DEST_PATHS[$idx]}" == "$path" ]]; then
			DEST_HASHES[$idx]="$hash"
			return
		fi
	done
	DEST_PATHS+=("$path")
	DEST_HASHES+=("$hash")
}

find_dest_by_hash() {
	local needle="$1" idx
	for idx in ${!DEST_HASHES[@]}; do
		if [[ "${DEST_HASHES[$idx]}" == "$needle" ]]; then
			printf '%s\n' "${DEST_PATHS[$idx]}"
			return 0
		fi
	done
	return 1
}

build_dest_hash_cache() {
	DEST_HASHES=()
	DEST_PATHS=()
	if [[ ! -d "$DEST_DIR" ]]; then
		return
	fi

	local cache_tmp
	cache_tmp=$(mktemp)
	python3 - "$DEST_DIR" "$HASH_CACHE_FILE" "$REHASH_CACHE" <<'PY' >"$cache_tmp"
import hashlib
import json
import os
import sys

dest, cache_path, rehash_flag = sys.argv[1:4]
rehash_flag = rehash_flag == "1"

if not os.path.isdir(dest):
	sys.exit(0)

cached = {}
if not rehash_flag and os.path.exists(cache_path):
	try:
		with open(cache_path, "r", encoding="utf-8") as fh:
			cached = json.load(fh)
	except (json.JSONDecodeError, OSError):
		cached = {}


def file_hash(path):
	h = hashlib.sha256()
	with open(path, "rb") as fh:
		for chunk in iter(lambda: fh.read(1 << 20), b""):
			h.update(chunk)
	return h.hexdigest()

updated = {}
reused = 0
computed = 0

def emit(line):
	try:
		print(line)
	except BrokenPipeError:
		sys.exit(0)

for root, _, files in os.walk(dest):
	for name in files:
		if not name.lower().endswith(".pdf"):
			continue
		path = os.path.join(root, name)
		try:
			stat = os.stat(path)
		except FileNotFoundError:
			continue
		key = path
		info = cached.get(key)
		if (not rehash_flag and info
			and info.get("size") == stat.st_size
			and abs(info.get("mtime", 0) - stat.st_mtime) < 0.0001):
			file_hash_value = info.get("hash")
			reused += 1
		else:
			file_hash_value = file_hash(path)
			computed += 1
			if computed % 25 == 0:
				print(f"  hashed {computed} new file(s)...", file=sys.stderr, flush=True)
		updated[key] = {
			"hash": file_hash_value,
			"size": stat.st_size,
			"mtime": stat.st_mtime,
		}
		emit(f"{file_hash_value}\t{path}")

try:
	with open(cache_path, "w", encoding="utf-8") as fh:
		json.dump(updated, fh, indent=2)
except OSError as exc:
	print(f"Warning: unable to update hash cache: {exc}", file=sys.stderr)

print(
	f"Hash cache ready (reused {reused}, computed {computed}).",
	file=sys.stderr,
	flush=True,
)
PY

	while IFS=$'\t' read -r hash path; do
		[[ -z "$hash" ]] && continue
		DEST_HASHES+=("$hash")
		DEST_PATHS+=("$path")
	done < "$cache_tmp"

	rm -f "$cache_tmp"
}

report_destination_duplicates() {
	local dup_tmp dup_json
	dup_tmp=$(mktemp)
	echo "Checking for duplicate PDFs already in destination..."
	if ! emit_hash_cache | python3 - <<'PY' >"$dup_tmp"
import json
import sys

groups = {}
for line in sys.stdin:
	line = line.rstrip("\n")
	if not line:
		continue
	try:
		hsh, path = line.split("\t", 1)
	except ValueError:
		continue
	groups.setdefault(hsh, []).append(path)

dups = {h: paths for h, paths in groups.items() if len(paths) > 1}
print(json.dumps(dups))
PY
	then
		echo "Warning: duplicate scan failed; continuing without cleanup." >&2
		rm -f "$dup_tmp"
		return
	fi
	dup_json=$(<"$dup_tmp")
	rm -f "$dup_tmp"
	if [[ -z "$dup_json" || "$dup_json" == "{}" ]]; then
		echo "No duplicates detected."
		return
	fi

	echo "Duplicate PDFs detected in destination (same content under multiple names):"
	python3 - "$dup_json" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
for hsh in sorted(data):
	paths = data[hsh]
	print(f"  hash {hsh[:12]}... ({len(paths)} copies)")
	for path in paths:
		print(f"    - {path}")
PY

	if (( DRY_RUN )); then
		echo "Dry run: not removing duplicate copies."
		return
	fi

	if ! prompt_yes_no_default_no "Delete duplicate copies now (keeps the first path listed)?"; then
		echo "Leaving duplicates in place."
		return
	fi

	local deleted_tmp deleted
	deleted_tmp=$(mktemp)
	python3 - "$dup_json" <<'PY' >"$deleted_tmp"
import json
import os
import sys

data = json.loads(sys.argv[1])
removed = []
for hsh, paths in data.items():
	keep = paths[0]
	for path in paths[1:]:
		if os.path.exists(path):
			try:
				os.remove(path)
			except OSError:
				continue
			removed.append((hsh, path))
print("\n".join(f"{h}\t{p}" for h, p in removed))
PY
	deleted=$(<"$deleted_tmp")
	rm -f "$deleted_tmp"

	if [[ -z "$deleted" ]]; then
		echo "No duplicate files were deleted (they may have been removed manually)."
		return
	fi

	local count=0
	while IFS=$'\t' read -r hash_value removed_path; do
		[[ -z "$removed_path" ]] && continue
		log_action "delete_duplicate" "" "$removed_path" "dest_cleanup" "$hash_value"
		remove_dest_entry "$removed_path"
		count=$((count + 1))
	done <<< "$deleted"

	echo "Removed ${count} duplicate file(s)."
	COUNT_DUPES_DELETED=$((COUNT_DUPES_DELETED + count))
	build_dest_hash_cache
}

suggest_new_name() {
	local filename="$1" stem ext candidate i=1
	stem="${filename%.*}"
	ext="${filename##*.}"
	if [[ "$stem" == "$filename" ]]; then
		ext=""
	else
		ext=".${ext}"
	fi
	while true; do
		candidate="${stem}_${i}${ext}"
		if [[ ! -e "${DEST_DIR}/${candidate}" ]]; then
			printf '%s' "$candidate"
			return
		fi
		((i++))
	done
}

PROMPT_RENAME_SUGGESTION=""
PROMPT_FORCE_AUTO_RENAME=0

prompt_conflict_action() {
	local filename="$1"
	PROMPT_RENAME_SUGGESTION=$(suggest_new_name "$filename")
	PROMPT_FORCE_AUTO_RENAME=0
	while true; do
		read -r -p "[O]verwrite, [R]ename, [S]kip, [AO] Always overwrite, [AS] Always skip, [AR] Always rename: " reply
		case "$reply" in
			O|o) echo "overwrite"; return ;;
			S|s) echo "skip"; return ;;
			R|r) echo "rename"; return ;;
			AO|ao) DEFAULT_ACTION="overwrite"; echo "overwrite"; return ;;
			AS|as) DEFAULT_ACTION="skip"; echo "skip"; return ;;
			AR|ar)
				DEFAULT_ACTION="rename"
				PROMPT_FORCE_AUTO_RENAME=1
				echo "rename"
				return
				;;
			*) echo "Please choose O, R, S, AO, AS, or AR." ;;
		esac
	done
}

copy_file() {
	local src="$1" dest="$2" action="$3" note="$4" file_hash="${5:-}"
	if (( DRY_RUN )); then
		echo "DRY RUN: ${action} -> ${dest}"
	else
		mkdir -p "${DEST_DIR}"
		cp -f "$src" "$dest"
	fi
	log_action "$action" "$src" "$dest" "$note" "$file_hash"
	if [[ -n "$file_hash" ]]; then
		register_hash "$dest" "$file_hash"
	fi
}

handle_conflict() {
	local src="$1" dest="$2" file_hash="$3" filename action rename_target
	filename=$(basename "$dest")
	PROMPT_RENAME_SUGGESTION=""
	echo "Conflict (different content): ${filename}"
	case "$DEFAULT_ACTION" in
		overwrite) action="overwrite" ;;
		skip) action="skip" ;;
		rename)
			action="rename"
			rename_target=$(suggest_new_name "$filename")
			dest="${DEST_DIR}/${rename_target}"
			echo "Renaming to ${rename_target}"
			;;
		prompt|*)
			action=$(prompt_conflict_action "$filename")
			if [[ "$action" == "rename" ]]; then
				[[ -z "$PROMPT_RENAME_SUGGESTION" ]] && PROMPT_RENAME_SUGGESTION=$(suggest_new_name "$filename")
				if (( PROMPT_FORCE_AUTO_RENAME )); then
					dest="${DEST_DIR}/${PROMPT_RENAME_SUGGESTION}"
					echo "Renaming to ${PROMPT_RENAME_SUGGESTION}"
					PROMPT_FORCE_AUTO_RENAME=0
				else
					local _choice=""
					while true; do
						read -r -p "Rename to '${PROMPT_RENAME_SUGGESTION}'? [Enter=Yes, S=Skip, O=Overwrite]: " _choice
						case "$_choice" in
							"")
								dest="${DEST_DIR}/${PROMPT_RENAME_SUGGESTION}"
								echo "Renaming to ${PROMPT_RENAME_SUGGESTION}"
								break
								;;
							S|s)
								action="skip"
								dest="${DEST_DIR}/${filename}"
								break
								;;
							O|o)
								action="overwrite"
								dest="${DEST_DIR}/${filename}"
								break
								;;
							*) echo "Press Enter to accept, or choose S/O." ;;
						esac
					done
				fi
			fi
			;;
	esac

	case "$action" in
		skip)
			log_action "skip" "$src" "$dest" "different_content" "$file_hash"
			echo "Skipped (different content): $(basename "$src")"
			COUNT_SKIP_DIFF_CONTENT=$((COUNT_SKIP_DIFF_CONTENT + 1))
			;;
		overwrite)
			copy_file "$src" "$dest" "overwrite" "different_content" "$file_hash"
			COUNT_OVERWRITTEN=$((COUNT_OVERWRITTEN + 1))
			;;
		rename)
			copy_file "$src" "$dest" "rename" "different_content" "$file_hash"
			COUNT_RENAMED=$((COUNT_RENAMED + 1))
			;;
		*)
			echo "Unhandled action $action" >&2
			;;
	esac
}

process_file() {
	local src="$1" filename dest src_hash existing_path
	filename=$(basename "$src")
	dest="${DEST_DIR}/${filename}"
	TOTAL_MATCHES=$((TOTAL_MATCHES + 1))
	src_hash=$(hash_file "$src" || true)
	if [[ -z "$src_hash" ]]; then
		echo "Failed to hash ${src}, skipping" >&2
		return
	fi

	if existing_path=$(find_dest_by_hash "$src_hash"); then
		log_action "skip" "$src" "$existing_path" "duplicate_content" "$src_hash"
		echo "Skipped (duplicate content -> $(basename "$existing_path")): ${filename}"
		COUNT_SKIP_DUP_CONTENT=$((COUNT_SKIP_DUP_CONTENT + 1))
		return
	fi

	if [[ ! -e "$dest" ]]; then
		copy_file "$src" "$dest" "copy" "new" "$src_hash"
		echo "Copied: ${filename}"
		COUNT_COPIED=$((COUNT_COPIED + 1))
		return
	fi

	if cmp -s "$src" "$dest"; then
		log_action "skip" "$src" "$dest" "identical_name" "$src_hash"
		echo "Skipped (identical): ${filename}"
		COUNT_SKIP_IDENTICAL=$((COUNT_SKIP_IDENTICAL + 1))
		return
	fi

	handle_conflict "$src" "$dest" "$src_hash"
}

parse_args() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
			-d|--dest)
				DEST_DIR="$2"
				shift 2
				;;
			-l|--log)
				LOG_FILE="$2"
				shift 2
				;;
			--hash-cache)
				HASH_CACHE_FILE="$2"
				shift 2
				;;
			-a|--always)
				DEFAULT_ACTION="$2"
				shift 2
				;;
			-f|--patterns-file)
				PATTERN_FILE="$2"
				shift 2
				;;
			-p|--pattern)
				EXTRA_PATTERNS+=("$2")
				shift 2
				;;
			-n|--dry-run)
				DRY_RUN=1
				shift
				;;
			--rehash-cache)
				REHASH_CACHE=1
				shift
				;;
			--skip-mount)
				SKIP_MOUNT=1
				shift
				;;
			-h|--help)
				usage
				exit 0
				;;
			--)
				shift
				break
				;;
			*)
				echo "Unknown option: $1" >&2
				usage
				exit 1
				;;
		esac
	done
}

validate_default_action() {
	case "$DEFAULT_ACTION" in
		prompt|overwrite|skip|rename) ;;
		*)
			echo "Unsupported --always action: ${DEFAULT_ACTION}" >&2
			exit 1
			;;
	esac
}

main() {
	parse_args "$@"
	validate_default_action
	require_python
	ensure_mount
	mkdir -p "$DEST_DIR"
	build_dest_hash_cache
	report_destination_duplicates
	if (( DRY_RUN )); then
		echo "Dry run mode enabled: no files will be copied or deleted."
	fi

	PATTERNS=()
	while IFS= read -r pattern; do
		[[ -z "$pattern" ]] && continue
		PATTERNS+=("$pattern")
	done < <(load_patterns)
	echo "Loaded ${#PATTERNS[@]} search pattern(s)."
	if ((${#PATTERNS[@]} == 0)); then
		echo "No patterns to evaluate" >&2
		exit 1
	fi

	MATCHES=()
	while IFS= read -r file; do
		[[ -z "$file" ]] && continue
		MATCHES+=("$file")
	done < <(expand_matches "${PATTERNS[@]}")
	echo "Found ${#MATCHES[@]} candidate file(s) from source patterns."
	if ((${#MATCHES[@]} == 0)); then
		echo "No PDF files found for provided patterns"
		exit 0
	fi

	echo "Processing ${#MATCHES[@]} file(s)..."
	for file in "${MATCHES[@]}"; do
		process_file "$file"
	done

	echo "Done. Actions logged to ${LOG_FILE}"
	echo "Summary:"
	echo "  Candidates processed: ${TOTAL_MATCHES}"
	echo "  Copied: ${COUNT_COPIED}"
	echo "  Overwritten: ${COUNT_OVERWRITTEN}"
	echo "  Renamed: ${COUNT_RENAMED}"
	echo "  Skipped (duplicate content): ${COUNT_SKIP_DUP_CONTENT}"
	echo "  Skipped (identical name/content): ${COUNT_SKIP_IDENTICAL}"
	echo "  Skipped (different content): ${COUNT_SKIP_DIFF_CONTENT}"
	echo "  Destination duplicates removed: ${COUNT_DUPES_DELETED}"
}

main "$@"



