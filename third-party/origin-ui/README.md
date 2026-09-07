Origin UI controls
==================

Source: https://github.com/coss-ui/coss/tree/main/apps/origin/registry/default/ui

Copied from the MIT apps/origin subproject, not the AGPL packages/ui project.
The original copyright and license are preserved in LICENSE.md.

Switch, Checkbox, RadioGroup, Input, Button and Select preserve the upstream
component and primitive structure. Imports use local utils and existing Radix
icons. Select accepts an explicit portal container for the owning window.
Slider retains Root/Track/Range/Thumb and controlled value behavior; the unused
optional tooltip is omitted to match the approved interface.
Scoped CSS adapts dimensions and colors to EchoInk without a global preflight.
