---
id: RouterStateType
title: RouterState type
---

The `RouterState` type represents the observable state of the router, including
the requested and resolved locations, match presentation, and foreground loading
status.

```tsx
type RouterState = {
  frameId: number
  status: 'pending' | 'idle'
  isLoading: boolean
  matches: Array<RouteMatch>
  location: ParsedLocation
  resolvedLocation?: ParsedLocation
}
```

## RouterState properties

The `RouterState` type contains all of the properties that are available on the router state.

### `frameId` property

- Type: `number`
- Identity for one atomically assembled snapshot of **route content** —
  `location`, `matches` and `resolvedLocation`. Every state the router
  assembles gets a new, larger value.
- It identifies a snapshot rather than a navigation: a single navigation
  assembles several, and the value carries no meaning beyond comparison and
  ordering. Do not derive a location, a match, or a count of navigations from
  it.
- **Not a change token for the whole state.** `status` and `isLoading` are
  navigation progress rather than route content, and a framework adapter may
  overlay them onto a snapshot a component is already presenting while keeping
  its `frameId` — the identity is what the adapter matches an acknowledgement
  against, so changing it there would orphan the render it belongs to. Two
  states sharing a `frameId` therefore agree on route content but can differ in
  progress. Select the fields you depend on rather than versioning on this.

### `status` property

- Type: `'pending' | 'idle'`
- The current foreground status of the router. `pending` means the requested route is still loading or waiting for its framework transition to settle.

### `isLoading` property

- Type: `boolean`
- `true` when `status` is `pending`.
- Background loader refreshes do not change this value. Inspect each match's `isFetching` field to observe foreground `beforeLoad`/loader work and background loader work.

### `matches` property

- Type: [`Array<RouteMatch>`](./RouteMatchType.md)
- The match presentation currently exposed to the application.
- A navigation can keep the previous presentation visible until pending UI is
  published. Once the destination is presented, this contains its complete
  structurally matched lane, including descendants that are still loading.
- Error and not-found results also preserve the complete structurally matched
  lane. Rendering stops at the selected pending or terminal boundary; it does
  not truncate this array.

### `location` property

- Type: [`ParsedLocation`](./ParsedLocationType.md)
- The latest location that the router has parsed from the browser history. This location may not be resolved and loaded yet.

### `resolvedLocation` property

- Type: [`ParsedLocation`](./ParsedLocationType.md) | `undefined`
- The location whose load and framework transition have settled. It is `undefined` before the initial location resolves.
