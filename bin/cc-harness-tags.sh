# cc-hub — bash library: the tmux session tag of every built-in coding agent,
# in ONE place.
#
# Sessions are named cc-<tag><name>: cc-<name> for claude, cc-oc-<name> for
# opencode, cc-he-<name> for hermes, cc-cu-<name> for cursor. cc-attach and
# cc-kill each used to carry their own copy of that table and of the reverse
# lookup, and both copies had gone stale in the same way — cursor was missing
# from them, so every cc-cu-* session was reported as claude.
#
# Sourced, not executed. No shebang, no `set -e`: it must not change the shell
# that reads it.
#
# Deliberately NOT the source cc-start builds a session name from. That script
# spells its four harnesses out itself and has to keep working with nothing
# installed but tmux; a name that depended on a second file could differ
# depending on how cc-start was called, which is worse than a five-line case.
#
# A coding agent that arrived as a cc-hub plugin brings its own tag in its
# launch spec, and cc-start notes it down the first time it launches one — see
# the tag file below. That is the only moment anybody on this machine knows
# that 'cc-fa-' means 'fakeagent': these two scripts read tmux, not the hub's
# database. A tag nothing ever wrote down still answers 'claude', which is what
# the untagged name cc-<name> has always meant.

CC_PREFIX="${CC_PREFIX:-cc-}"

# id:tag. Order matters for the reverse lookup: the empty tag (claude) matches
# everything and therefore comes last.
CC_HARNESS_TAGS=("opencode:oc-" "hermes:he-" "cursor:cu-")

# Coding agents that are not built in: one '<id>:<tag>' line each, appended by
# cc-start when it launches one from its --spec declaration. Missing is the
# normal case. Anything that is not exactly one id and one tag is skipped
# rather than trusted — this string ends up being compared against tmux session
# names.
CC_HARNESS_TAGS_FILE="${CCHUB_HARNESS_TAGS:-${XDG_DATA_HOME:-$HOME/.local/share}/cc-hub/harness-tags}"
if [[ -r "$CC_HARNESS_TAGS_FILE" ]]; then
    while IFS= read -r _cc_line || [[ -n "$_cc_line" ]]; do
        [[ "$_cc_line" =~ ^[a-z0-9][a-z0-9-]*:[A-Za-z0-9_-]+$ ]] || continue
        CC_HARNESS_TAGS+=("$_cc_line")
    done < "$CC_HARNESS_TAGS_FILE"
    unset _cc_line
fi

CC_HARNESS_TAGS+=("claude:")

# The ids, space separated — for allowlists and error messages.
cc_harness_ids() {
    local e ids=()
    for e in "${CC_HARNESS_TAGS[@]}"; do ids+=("${e%%:*}"); done
    printf '%s' "${ids[*]}"
}

# Is this a coding agent these scripts know?
cc_harness_known() {
    local e
    for e in "${CC_HARNESS_TAGS[@]}"; do [[ "${e%%:*}" == "$1" ]] && return 0; done
    return 1
}

# Session name -> coding agent id. Unknown prefixes answer 'claude', which is
# what the untagged name cc-<name> means.
cc_harness_of() {
    local e tag
    for e in "${CC_HARNESS_TAGS[@]}"; do
        tag="${e#*:}"
        [[ -z "$tag" ]] && continue
        [[ "$1" == "$CC_PREFIX$tag"* ]] && { printf '%s' "${e%%:*}"; return 0; }
    done
    printf 'claude'
}

# Session name -> the bare name, without cc- and without the harness tag.
cc_harness_bare() {
    local bare="${1#"$CC_PREFIX"}" e tag
    for e in "${CC_HARNESS_TAGS[@]}"; do
        tag="${e#*:}"
        [[ -z "$tag" ]] && continue
        [[ "$bare" == "$tag"* ]] && { printf '%s' "${bare#"$tag"}"; return 0; }
    done
    printf '%s' "$bare"
}
