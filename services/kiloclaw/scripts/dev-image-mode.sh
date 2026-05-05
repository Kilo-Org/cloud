#!/bin/sh

kiloclaw_read_dev_var() {
  if [ ! -f "$1/.dev.vars" ]; then
    return 0
  fi

  grep "^$2=" "$1/.dev.vars" | head -1 | sed 's/^[^=]*=//' | sed 's/^"//;s/"$//' || true
}

kiloclaw_set_dev_var() {
  kiloclaw_set_dev_var_file="$1"
  kiloclaw_set_dev_var_key="$2"
  kiloclaw_set_dev_var_value="$3"
  kiloclaw_set_dev_var_escaped="$(printf '%s' "$kiloclaw_set_dev_var_value" | sed 's/[&|]/\\&/g')"

  if grep -q "^${kiloclaw_set_dev_var_key}=" "$kiloclaw_set_dev_var_file"; then
    sed "s|^${kiloclaw_set_dev_var_key}=.*|${kiloclaw_set_dev_var_key}=${kiloclaw_set_dev_var_escaped}|" \
      "$kiloclaw_set_dev_var_file" > "$kiloclaw_set_dev_var_file.tmp"
    mv "$kiloclaw_set_dev_var_file.tmp" "$kiloclaw_set_dev_var_file"
  else
    printf '%s=%s\n' "$kiloclaw_set_dev_var_key" "$kiloclaw_set_dev_var_value" >> "$kiloclaw_set_dev_var_file"
  fi
}

kiloclaw_local_openclaw_tarballs() {
  find "$1/openclaw-build" -maxdepth 1 -type f -name 'openclaw-*.tgz' 2>/dev/null | sort || true
}

kiloclaw_count_lines() {
  printf '%s\n' "$1" | sed '/^$/d' | wc -l | tr -d ' '
}

kiloclaw_try_resolve_local_openclaw_tarball() {
  kiloclaw_try_tarballs="$(kiloclaw_local_openclaw_tarballs "$1")"
  kiloclaw_try_count="$(kiloclaw_count_lines "$kiloclaw_try_tarballs")"

  if [ "$kiloclaw_try_count" -eq 1 ]; then
    printf '%s\n' "$kiloclaw_try_tarballs"
    return 0
  fi

  return 1
}

kiloclaw_resolve_local_openclaw_tarball() {
  kiloclaw_resolve_dir="$1"
  kiloclaw_resolve_tarballs="$(kiloclaw_local_openclaw_tarballs "$kiloclaw_resolve_dir")"
  kiloclaw_resolve_count="$(kiloclaw_count_lines "$kiloclaw_resolve_tarballs")"

  if [ "$kiloclaw_resolve_count" -eq 0 ]; then
    echo "Error: No openclaw-*.tgz found in openclaw-build/." >&2
    echo "Build your fork first:" >&2
    echo "  cd /path/to/openclaw && pnpm build && npm pack" >&2
    echo "  cp openclaw-*.tgz $(cd "$kiloclaw_resolve_dir" && pwd)/openclaw-build/" >&2
    return 1
  fi

  if [ "$kiloclaw_resolve_count" -gt 1 ]; then
    echo "Error: Multiple openclaw-*.tgz files found in openclaw-build/." >&2
    echo "$kiloclaw_resolve_tarballs" >&2
    echo "Keep exactly one tarball so Dockerfile.local and the content hash use the same input." >&2
    return 1
  fi

  printf '%s\n' "$kiloclaw_resolve_tarballs"
}

kiloclaw_compute_image_hash() {
  kiloclaw_hash_dir="$1"
  kiloclaw_hash_mode="$2"
  kiloclaw_hash_tarball="${3:-}"

  case "$kiloclaw_hash_mode" in
    local)
      "$kiloclaw_hash_dir/scripts/image-content-hash.sh" --hash --dockerfile Dockerfile.local --openclaw-tarball "$kiloclaw_hash_tarball"
      ;;
    production)
      "$kiloclaw_hash_dir/scripts/image-content-hash.sh" --hash --dockerfile Dockerfile
      ;;
    *)
      echo "Unknown image content mode: $kiloclaw_hash_mode" >&2
      return 1
      ;;
  esac
}

kiloclaw_dev_image_plan() {
  kiloclaw_plan_dir="$1"
  kiloclaw_plan_requested_mode="${2:-}"
  kiloclaw_plan_stored_mode="$(kiloclaw_read_dev_var "$kiloclaw_plan_dir" FLY_IMAGE_CONTENT_MODE)"
  kiloclaw_plan_stored_hash="$(kiloclaw_read_dev_var "$kiloclaw_plan_dir" FLY_IMAGE_CONTENT_HASH)"
  kiloclaw_plan_mode="$kiloclaw_plan_requested_mode"
  kiloclaw_plan_tarball=""
  kiloclaw_plan_hash=""
  kiloclaw_plan_inferred="false"

  case "$kiloclaw_plan_requested_mode" in
    ""|local|production) ;;
    *)
      echo "Unknown requested image mode: $kiloclaw_plan_requested_mode" >&2
      return 1
      ;;
  esac

  case "$kiloclaw_plan_stored_mode" in
    ""|local|production) ;;
    *)
      echo "Unknown FLY_IMAGE_CONTENT_MODE in .dev.vars: $kiloclaw_plan_stored_mode" >&2
      echo "Expected local or production." >&2
      return 1
      ;;
  esac

  if [ -z "$kiloclaw_plan_mode" ]; then
    if [ -n "$kiloclaw_plan_stored_mode" ]; then
      kiloclaw_plan_mode="$kiloclaw_plan_stored_mode"
    elif [ -n "$kiloclaw_plan_stored_hash" ] &&
      kiloclaw_plan_tarball="$(kiloclaw_try_resolve_local_openclaw_tarball "$kiloclaw_plan_dir")"; then
      kiloclaw_plan_local_hash="$(kiloclaw_compute_image_hash "$kiloclaw_plan_dir" local "$kiloclaw_plan_tarball")"
      if [ "$kiloclaw_plan_local_hash" = "$kiloclaw_plan_stored_hash" ]; then
        kiloclaw_plan_mode="local"
        kiloclaw_plan_hash="$kiloclaw_plan_local_hash"
        kiloclaw_plan_inferred="true"
      fi
    fi
  fi

  kiloclaw_plan_mode="${kiloclaw_plan_mode:-production}"

  if [ "$kiloclaw_plan_mode" = "local" ]; then
    if [ -z "$kiloclaw_plan_tarball" ]; then
      kiloclaw_plan_tarball="$(kiloclaw_resolve_local_openclaw_tarball "$kiloclaw_plan_dir")"
    fi
    if [ -z "$kiloclaw_plan_hash" ]; then
      kiloclaw_plan_hash="$(kiloclaw_compute_image_hash "$kiloclaw_plan_dir" local "$kiloclaw_plan_tarball")"
    fi
  else
    kiloclaw_plan_hash="$(kiloclaw_compute_image_hash "$kiloclaw_plan_dir" production)"
  fi

  printf '%s\n%s\n%s\n%s\n' "$kiloclaw_plan_mode" "$kiloclaw_plan_hash" "$kiloclaw_plan_tarball" "$kiloclaw_plan_inferred"
}
