Output docs/assets/demo.gif

# Rendering notes, not rendering logic. The demo's timing lives in
# tools/demo.sh (DEMO_PACE), so this tape stays one command long and a change to
# the demo changes the GIF with it. That is the point of VHS over recording a
# live session: the artifact is reproducible, which for this project is not a
# nicety.

Set Shell "bash"
Set FontSize 15
Set FontFamily "JetBrains Mono"
Set LetterSpacing 0
Set Width 1000
Set Height 620
Set Theme {"background": "#0d1117", "foreground": "#c9d1d9", "accent": "#58a6ff"}
Set PlaybackSpeed 1

# DEMO_FAST runs the guard tests (4, ~1s) instead of the full 92-test gate.
# DEMO_PACE holds each step so the refusals are readable in a GIF.
Type "DEMO_FAST=1 DEMO_PACE=3 ./tools/demo.sh"
Enter
Sleep 13
