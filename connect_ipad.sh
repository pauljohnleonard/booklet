#!/usr/bin/env bash
set -euo pipefail

APP="com.mgsdevelopment.forscore"
MOUNT_POINT="${MOUNT_POINT:-$HOME/mnt/ipad}"

action="${1:-mount}"

usage() {
	cat <<EOF
Usage: ${0##*/} [mount|unmount|status]

Helper for attaching/detaching the forScore documents folder via ifuse.
Set MOUNT_POINT to override the default of "${HOME}/mnt/ipad".
EOF
}

require_ifuse() {
	if ! command -v ifuse >/dev/null 2>&1; then
		echo "ifuse is required (brew install ifuse)" >&2
		exit 1
	fi
}

mount_entry_active() {
	mount | grep -F " on ${MOUNT_POINT} " >/dev/null 2>&1
}

is_mount_healthy() {
	if ! mount_entry_active; then
		return 1
	fi
	ls "${MOUNT_POINT}" >/dev/null 2>&1
}

reset_stale_mount() {
	if mount_entry_active && ! is_mount_healthy; then
		echo "Mount point ${MOUNT_POINT} looks stale; forcing unmount..."
		unmount_ipad true || true
	fi
}

mount_ipad() {
	require_ifuse
	reset_stale_mount
	if is_mount_healthy; then
		echo "Already mounted at ${MOUNT_POINT}"
		return
	fi
	mkdir -p "${MOUNT_POINT}"
	echo "Mounting forScore documents..."
	ifuse --documents "${APP}" "${MOUNT_POINT}"
	if is_mount_healthy; then
		echo "Mounted to ${MOUNT_POINT}"
	else
		echo "ifuse reported success but mount is not readable." >&2
		exit 1
	fi
}

unmount_ipad() {
	local force_msg=""
	if [[ ${1:-false} == true ]]; then
		force_msg=" (forced)"
	fi
	if ! mount_entry_active; then
		if [[ -n "$force_msg" ]]; then
			rmdir "${MOUNT_POINT}" >/dev/null 2>&1 || true
		fi
		echo "Mount point ${MOUNT_POINT} is not active"
		return
	fi
	echo "Detaching ${MOUNT_POINT}${force_msg}..."
	if diskutil unmount force "${MOUNT_POINT}" >/dev/null 2>&1; then
		echo "Unmounted via diskutil"
		return
	fi
	if umount "${MOUNT_POINT}" >/dev/null 2>&1; then
		echo "Unmounted via umount"
		return
	fi
	if command -v fusermount >/dev/null 2>&1 && fusermount -u "${MOUNT_POINT}" >/dev/null 2>&1; then
		echo "Unmounted via fusermount"
		return
	fi
	echo "Unable to unmount ${MOUNT_POINT}. Close any apps using it and retry." >&2
	return 1
}

status_ipad() {
	if is_mount_healthy; then
		echo "Mounted at ${MOUNT_POINT}"
	elif mount_entry_active; then
		echo "Mount entry exists but is not readable (stale). Run: ${0##*/} unmount"
	else
		echo "Not currently mounted"
	fi
}

case "${action}" in
	mount) mount_ipad ;;
	unmount|umount) unmount_ipad ;;
	status) status_ipad ;;
	-h|--help) usage ;;
	*) echo "Unknown action: ${action}" >&2; usage; exit 1 ;;
esac
