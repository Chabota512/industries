---
name: Vite dependency prebundles
description: Stale optimized dependencies can survive a package version correction in the web preview.
---

In this workspace, the artifact's Vite dependency prebundle can continue loading an old React or React DOM version even when pnpm resolves a matching version pair. A successful package-tree check alone does not prove that the browser bundle was refreshed.

**Why:** The preview retained React 19.1.0 in its optimized dependency cache after the artifact had moved to React 19.1.4, producing a runtime mismatch.

**How to apply:** If a React version mismatch persists after pnpm shows matching versions, inspect the artifact's Vite optimized files and refresh that generated cache before changing package versions again.
