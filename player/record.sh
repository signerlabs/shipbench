#!/bin/zsh
# 用法：record.sh <操作脚本.json> <输出名>
# 在测评用户的模拟器里一边录屏、一边用 Player 按脚本操作；输出 <输出名>.mp4、<输出名>.marks（录屏开始和 App 启动、结束的时刻）
U=${SHIPBENCH_SIMULATOR:?需要 SHIPBENCH_SIMULATOR（测评用户的模拟器 UDID）}
cd ~/rec
xcrun simctl shutdown $U 2>/dev/null; xcrun simctl boot $U; xcrun simctl bootstatus $U -b >/dev/null; sleep 3
xcrun simctl status_bar $U override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
: > "$2.marks"
xcrun simctl io $U recordVideo --codec=h264 --force "$2.mp4" >/dev/null 2>&1 &
REC=$!
echo "rec $(perl -MTime::HiRes=time -e "printf q(%.3f), time")" >> "$2.marks"
TEST_RUNNER_PLAYER_SCRIPT=$HOME/rec/$1 TEST_RUNNER_PLAYER_MARK=$HOME/rec/$2.marks xcodebuild test-without-building -project ~/player/Player.xcodeproj -scheme Player -destination "platform=iOS Simulator,id=$U" -derivedDataPath ~/player-dd 2>&1 | grep -E "passed|failed|error:" | tail -1
sleep 1
echo "stop $(perl -MTime::HiRes=time -e "printf q(%.3f), time")" >> "$2.marks"
kill -INT $REC; wait $REC 2>/dev/null
cat "$2.marks"
