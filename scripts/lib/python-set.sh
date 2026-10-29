# shellcheck shell=bash
# python-set.sh -- sourced by release-playground.sh.
#
# The slim image's pages install the Python set from the live repository
# (src/python_install.ts), at the build of the python the image ships when
# it ships one: pkg never replaces an installed package (src/packages.ts
# `resolveSet`). These say which python that is, and whether the live
# repository has a set the image can take.

# The members of the set, and python-seal: the set's Suspend/Resume
# interpreter, published with it.
PYTHON_SET_PACKAGES=(python numpy pyzmq jupyter-kernel python-seal)

# slim_image_python IMAGE: "VERSION BUILD" of the python package in the
# image's pkg installed list (/var/lib/yurt-pkg/installed.list), or nothing
# when it lists none (or keeps no list). Returns 1 when IMAGE cannot be
# read as a zstd tar.
slim_image_python() {
  local image=$1 members
  members=$(zstd -dc "$image" | tar -tf -) || return 1
  grep -qx 'var/lib/yurt-pkg/installed.list' <<< "$members" || return 0
  zstd -dc "$image" | tar -xOf - var/lib/yurt-pkg/installed.list |
    awk -F'\t' '$1 == "python" { print $2 " " $3 }'
}

# python_set_builds [VERSION BUILD]: the yurt_N builds at which every
# package of PYTHON_SET_PACKAGES has an unyanked release in yurt-packages,
# one per line, oldest first. With VERSION and BUILD (the image's python),
# only BUILD, and only when python VERSION-BUILD itself is there. Returns 1
# when a package's metadata cannot be read.
python_set_builds() {
  local version=${1:-} build=${2:-} name builds common=""
  for name in "${PYTHON_SET_PACKAGES[@]}"; do
    builds=$(curl -fsSL --retry 3 "https://raw.githubusercontent.com/YurtOS/yurt-packages/main/packages/$name.json" |
      jq -r --arg name "$name" --arg version "$version" --arg build "$build" '.versions[]
        | select((.yanked | not) and (.build | test("^yurt_[0-9]+$")))
        | select($build == "" or .build == $build)
        | select($build == "" or $name != "python" or .version == $version)
        | .build' | sort -u) || return 1
    if [ "$name" = python ]; then common=$builds; else common=$(comm -12 <(echo "$common") <(echo "$builds")); fi
  done
  sed '/^$/d' <<< "$common" | sort -t_ -k2 -n
}
