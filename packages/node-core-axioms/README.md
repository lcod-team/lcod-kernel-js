# @lcod/core-node-axioms

Reference Node.js implementations for the LCOD core contract set (`core/fs`,
`core/http`, `core/stream`, `core/hash`, `core/parse`, ...). The package
exposes a single entry point:

```js
import { Registry } from 'lcod-kernel-js';
import { registerNodeCore } from '@lcod/core-node-axioms';

const registry = registerNodeCore(new Registry());
```

The distributable files in `dist/` are generated from the sources in
`lcod-kernel-js/src/core` via the repo-level script `npm run build:core-axioms`.
