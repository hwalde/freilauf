# Freilauf — bash library: the tmux session tag of every built-in coding agent,
# in ONE place.
#
# Sessions are named fl-<tag><name>: fl-<name> for claude, fl-oc-<name> for
# opencode, fl-he-<name> for hermes, fl-cu-<name> for cursor. fl-attach and
# fl-kill each used to carry their own copy of that table and of the reverse
# lookup, and both copies had gone stale in the same way — cursor was missing
# from them, so every -cu- session was reported as claude.
#
# The prefix was `cc-` before the project was renamed, and a session outlives
# the release that started it: an agent that has been working for hours is
# still sitting in `cc-<name>` while the new scripts are already installed. So
# BOTH prefixes are recognised here — listing, attaching and killing an old
# session keeps working — while `fl-start` only ever creates `fl-` ones.
#
# Sourced, not executed. No shebang, no `set -e`: it must not change the shell
# that reads it.
#
# Deliberately NOT the source fl-start builds a session name from. That script
# spells its four harnesses out itself and has to keep working with nothing
# installed but tmux; a name that depended on a second file could differ
# depending on how fl-start was called, which is worse than a five-line case.
#
# A coding agent that arrived as a Freilauf plugin brings its own tag in its
# launch spec, and fl-start notes it down the first time it launches one — see
# the tag file below. That is the only moment anybody on this machine knows
# that 'fl-fa-' means 'fakeagent': these two scripts read tmux, not the hub's
# database. A tag nothing ever wrote down still answers 'claude', which is what
# the untagged name fl-<name> has always meant.

FL_PREFIX="${FL_PREFIX:-fl-}"

# Every prefix a session on this machine may carry. The new one first: it is
# what a name is built from, and the reverse lookups try them in this order.
FL_PREFIXES=("$FL_PREFIX")
[[ "$FL_PREFIX" != "cc-" ]] && FL_PREFIXES+=("cc-")

# An ERE matching the start of any session name of ours — for `grep -E`.
fl_session_re() {
    local p out=""
    for p in "${FL_PREFIXES[@]}"; do out+="${out:+|}$p"; done
    printf '^(%s)' "$out"
}

# id:tag. Order matters for the reverse lookup: the empty tag (claude) matches
# everything and therefore comes last.
FL_HARNESS_TAGS=("opencode:oc-" "hermes:he-" "cursor:cu-")

# Coding agents that are not built in: one '<id>:<tag>' line each, appended by
# fl-start when it launches one from its --spec declaration. Missing is the
# normal case. Anything that is not exactly one id and one tag is skipped
# rather than trusted — this string ends up being compared against tmux session
# names.
if [[ -r "${BASH_SOURCE[0]%/*}/fl-paths.sh" ]]; then
    # shellcheck source=fl-paths.sh
    . "${BASH_SOURCE[0]%/*}/fl-paths.sh"
fi
if declare -F fl_env >/dev/null 2>&1; then
    FL_HARNESS_TAGS_FILE="$(fl_env HARNESS_TAGS)"
    [[ -n "$FL_HARNESS_TAGS_FILE" ]] || FL_HARNESS_TAGS_FILE="$(fl_data_dir)/harness-tags"
else
    FL_HARNESS_TAGS_FILE="${FREILAUF_HARNESS_TAGS:-${CCHUB_HARNESS_TAGS:-${XDG_DATA_HOME:-$HOME/.local/share}/freilauf/harness-tags}}"
fi
if [[ -r "$FL_HARNESS_TAGS_FILE" ]]; then
    while IFS= read -r _fl_line || [[ -n "$_fl_line" ]]; do
        [[ "$_fl_line" =~ ^[a-z0-9][a-z0-9-]*:[A-Za-z0-9_-]+$ ]] || continue
        FL_HARNESS_TAGS+=("$_fl_line")
    done < "$FL_HARNESS_TAGS_FILE"
    unset _fl_line
fi

FL_HARNESS_TAGS+=("claude:")

# The ids, space separated — for allowlists and error messages.
fl_harness_ids() {
    local e ids=()
    for e in "${FL_HARNESS_TAGS[@]}"; do ids+=("${e%%:*}"); done
    printf '%s' "${ids[*]}"
}

# Is this a coding agent these scripts know?
fl_harness_known() {
    local e
    for e in "${FL_HARNESS_TAGS[@]}"; do [[ "${e%%:*}" == "$1" ]] && return 0; done
    return 1
}

# Session name -> coding agent id. Unknown prefixes answer 'claude', which is
# what the untagged name fl-<name> means.
fl_harness_of() {
    local e tag p
    for p in "${FL_PREFIXES[@]}"; do
        for e in "${FL_HARNESS_TAGS[@]}"; do
            tag="${e#*:}"
            [[ -z "$tag" ]] && continue
            [[ "$1" == "$p$tag"* ]] && { printf '%s' "${e%%:*}"; return 0; }
        done
    done
    printf 'claude'
}

# Session name -> the bare name, without the prefix and without the harness tag.
fl_harness_bare() {
    local bare="$1" e tag p
    for p in "${FL_PREFIXES[@]}"; do
        [[ "$bare" == "$p"* ]] && { bare="${bare#"$p"}"; break; }
    done
    for e in "${FL_HARNESS_TAGS[@]}"; do
        tag="${e#*:}"
        [[ -z "$tag" ]] && continue
        [[ "$bare" == "$tag"* ]] && { printf '%s' "${bare#"$tag"}"; return 0; }
    done
    printf '%s' "$bare"
}
