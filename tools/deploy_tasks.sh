#!/bin/zsh
# Deploy tasks, graders and the replay project into the agent user: tools/deploy_tasks.sh [TASK ...]
# Run from your own account. Uses SHIPBENCH_USER / SHIPBENCH_USER_HOME / SHIPBENCH_SIMULATOR (see runner/local.env).
set -e
cd "$(dirname "$0")/.."
[ -f runner/local.env ] && set -a && . runner/local.env && set +a
U=${SHIPBENCH_USER:-agenteval}
H=${SHIPBENCH_USER_HOME:-/Users/$U}
as_user() { sudo -n -u "$U" -H zsh -lc "$1"; }
put_dir() { as_user "mkdir -p '$2'"; tar -C "$1" -cf - . | sudo -n -u "$U" tar -C "$2" -xf -; }
put_file() { cat "$1" | sudo -n -u "$U" tee "$2" >/dev/null; }

TASKS=(${@:-$(cd tasks && ls -d */ | tr -d /)})
as_user "mkdir -p $H/tasks $H/rec/shots $H/player"
for t in $TASKS; do
  [ -d "tasks/$t" ] || { echo "no such task: $t"; continue; }
  for sub in base hidden; do
    if [ -d "tasks/$t/$sub" ]; then put_dir "tasks/$t/$sub" "$H/tasks/$t-$sub"; fi
  done
  if [ -d "tasks/$t/reference" ]; then put_dir "tasks/$t/reference" "$H/tasks/$t-ref"; fi
  if [ -f "tasks/$t/grade.mjs" ]; then
    if [ "$t" = B4 ]; then put_file "tasks/$t/grade.mjs" "$H/tasks/grade.mjs"; else put_file "tasks/$t/grade.mjs" "$H/tasks/grade-$t.mjs"; fi
  fi
  for f in tasks/$t/*-play.json(N); do put_file "$f" "$H/tasks/$(basename $f)"; done
  echo "deployed $t"
done
for f in runner/grade_*.py; do put_file "$f" "$H/tasks/$(basename $f)"; done
# Code-quality tools, pinned versions (used by the backend grader)
as_user "mkdir -p $H/tasks/quality-tools && cd $H/tasks/quality-tools && ([ -f package.json ] || echo '{\"private\":true}' > package.json) && npm i --no-audit --no-fund typescript@5.9.3 @biomejs/biome@1.9.4 jscpd@4.0.5 >/dev/null"
# Replay project (XCUITest) for frontend tasks
put_dir player "$H/player"
put_file player/record.sh "$H/rec/record.sh"
as_user "chmod +x $H/rec/record.sh"
if [ -n "$SHIPBENCH_SIMULATOR" ]; then
  as_user "cd $H/player && xcodebuild build-for-testing -project Player.xcodeproj -scheme Player -destination 'platform=iOS Simulator,id=$SHIPBENCH_SIMULATOR' -derivedDataPath $H/player-dd >/dev/null && echo 'replay project built'"
else
  echo "SHIPBENCH_SIMULATOR not set: skipped building the replay project (frontend tasks need it)"
fi
