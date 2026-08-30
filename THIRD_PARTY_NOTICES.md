# Third-Party Notices

## SmoothUI

EchoInk includes native TypeScript DOM and CSS adaptations of the official
SmoothUI `Blur Out Up`, `AI Message`, `AI Reasoning`, `AI Tool Call`,
`AI Artifact`, `AI Task List`, `AI Diff`, `AI Approval`, `AI Sources`,
`AI Loader`, `AI Response`, and `AI Suggestions` component patterns.

Adapted official component sources:

- [Blur Out Up](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/blur-out-up/index.tsx)
- [AI Message](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-message/index.tsx)
- [AI Reasoning](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-reasoning/index.tsx)
- [AI Tool Call](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-tool-call/index.tsx)
- [AI Artifact](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-artifact/index.tsx)
- [AI Task List](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-task-list/index.tsx)
- [AI Diff](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-diff/index.tsx)
- [AI Approval](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-approval/index.tsx)
- [AI Sources](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-sources/index.tsx)
- [AI Loader](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-loader/index.tsx)
- [AI Response](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-response/index.tsx)
- [AI Suggestions](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-suggestions/index.tsx)

MIT License

Copyright (c) 2024 Eduardo Calvo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Vercel AI Elements

EchoInk includes modified native Obsidian TypeScript DOM and CSS adaptations
of the Vercel AI Elements `Sources` component for local document provenance,
the read-only `Task` component used for durable task-plan history, the
`Question` and `Confirmation` interaction semantics, and the `Attachments`
container, preview, info, and remove semantics, plus the `Shimmer` text-loading
effect used while an Assistant reply is being prepared.
The adaptation replaces React, Radix Collapsible, Tailwind CSS, and Lucide with
the existing Obsidian DOM and icon APIs, and it intentionally omits the
upstream external-link behavior.

Adapted upstream source at commit `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`:

- [Sources](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/sources.tsx)
- [Task](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/task.tsx)
- [Question](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/question.tsx)
- [Confirmation](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/confirmation.tsx)
- [Attachments](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/attachments.tsx)
- [Shimmer](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/shimmer.tsx)

Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## AnimateIcons

EchoInk includes dependency-free native SVG and CSS adaptations of the
AnimateIcons Lucide `Upload`, `Mic`, `Send Horizontal`, `Circle Stop`, `Users`,
and `User Round Pen` icons. The adaptation replaces React and Motion with the
existing Obsidian DOM and EchoInk motion tokens, including reduced-motion
behavior.

Adapted upstream sources at commit `e19861bd8e1e214105221040aefb27644fd1362f`:

- [Upload](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/upload-icon.tsx)
- [Mic](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/mic-icon.tsx)
- [Send Horizontal](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/send-horizontal-icon.tsx)
- [Circle Stop](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/circle-stop-icon.tsx)
- [Users](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/users-icon.tsx)
- [User Round Pen](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/user-round-pen-icon.tsx)

MIT License

Copyright (c) 2025 Avijit Dey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
