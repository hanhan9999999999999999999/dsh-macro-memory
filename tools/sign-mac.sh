#!/usr/bin/env bash
#
# mac 产物的签名 + 公证（PLAN-UNIVERSAL §11.4 / P2-4）。
#
#   MACRO_MEMORY_SIGN_IDENTITY="Developer ID Application: 你的名字 (TEAMID)" \
#   MACRO_MEMORY_NOTARY_PROFILE=macro-memory-notary \
#   tools/sign-mac.sh macro-memory-mac-arm64
#
# 为什么这一步必须单独是一个脚本：它只能在 macOS 上跑，而且要有 Apple 开发者账号。
# 没有账号的人打出来的二进制一样能跑，只是别人第一次打开会被 Gatekeeper 拦一次
# （右键 → 打开可以过）。判据能验的只有「脚本里四步都在」——`spctl` 通不通只有真机知道。
#
# 四步：
#   1. codesign —— 签，带 hardened runtime（--options runtime）与时间戳，公证的前提；
#   2. codesign --verify —— 自己先验一遍，别把坏签名送去公证；
#   3. notarytool submit --wait + stapler staple —— 送 Apple 公证，再把票据钉进文件；
#   4. spctl -a -vv —— 用 Gatekeeper 的眼睛看一遍（这就是 PLAN 里那条判据）。
#
# 凭据放 keychain profile（`xcrun notarytool store-credentials` 一次性配好），
# 不要写进这个脚本、也不要写进环境变量的默认值。

set -euo pipefail

BIN="${1:?用法：tools/sign-mac.sh <产物路径>}"
[ -f "$BIN" ] || { echo "找不到产物：$BIN" >&2; exit 1; }

: "${MACRO_MEMORY_SIGN_IDENTITY:?设 MACRO_MEMORY_SIGN_IDENTITY（Developer ID Application: …）}"
: "${MACRO_MEMORY_NOTARY_PROFILE:?设 MACRO_MEMORY_NOTARY_PROFILE（xcrun notarytool store-credentials 建的那个名字）}"

echo "== 1. 签名（hardened runtime + 时间戳）"
codesign --force --options runtime --timestamp --sign "$MACRO_MEMORY_SIGN_IDENTITY" "$BIN"

echo "== 2. 自验签名"
codesign --verify --strict --verbose=2 "$BIN"

echo "== 3. 送公证（这一步会等 Apple，通常几分钟）"
ZIP="${BIN}.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$BIN" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$MACRO_MEMORY_NOTARY_PROFILE" --wait
xcrun stapler staple "$BIN"
rm -f "$ZIP"

echo "== 4. Gatekeeper 检查（PLAN 的判据就是这条）"
spctl -a -vv "$BIN"

echo "== 校验和"
shasum -a 256 "$BIN"
