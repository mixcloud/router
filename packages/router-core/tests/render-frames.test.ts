import { describe, expect, test, vi } from 'vitest'
import { createMemoryHistory } from '@tanstack/history'
import {
  BaseRootRoute,
  BaseRoute,
  createNonReactiveMutableStore,
  createNonReactiveReadonlyStore,
} from '../src'
import { createRouterStores } from '../src/stores'
import { createTestRouter } from './routerTestUtils'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function createRouter() {
  const rootRoute = new BaseRootRoute({})
  const indexRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/',
  })
  const aboutRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/about',
  })
  const postRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/posts/$postId',
  })

  return createTestRouter({
    routeTree: rootRoute.addChildren([indexRoute, aboutRoute, postRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

describe('render frames', () => {
  test('the initial router state carries a frame identity', () => {
    const router = createRouter()
    expect(typeof router.state.frameId).toBe('number')
  })

  test('every assembled state gets a new, increasing frame identity', async () => {
    const router = createRouter()

    const first = router.stores.__store.get().frameId
    await router.navigate({ to: '/about' })
    const second = router.stores.__store.get().frameId
    await router.navigate({ to: '/posts/123' })
    const third = router.stores.__store.get().frameId

    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  })

  /**
   * The SSR store is non-reactive: its getter runs again for every reader. So
   * counting reads rather than publications gave two consumers in one server
   * render different identities for the same route content, and anything an
   * application derived from one would differ between the server and the
   * client, whose store caches the assembly.
   */
  test('repeated reads of unchanged route content share an identity', () => {
    // Built with the SSR config on purpose: the client store caches its
    // assembly, so only the non-reactive one reruns the getter per reader.
    const stores = createRouterStores(
      createMemoryHistory({ initialEntries: ['/about'] }).location as any,
      {
        createMutableStore: createNonReactiveMutableStore,
        createReadonlyStore: createNonReactiveReadonlyStore,
        batch: (fn) => fn(),
      },
    )

    const first = stores.__store.get()
    const second = stores.__store.get()
    const third = stores.__store.get()

    expect(second.frameId).toBe(first.frameId)
    expect(third.frameId).toBe(first.frameId)

    // And it still advances when the content does.
    stores.setMatches([
      { id: '__root__', routeId: '__root__' } as any,
    ])
    expect(stores.__store.get().frameId).toBeGreaterThan(first.frameId)
  })

  /**
   * Progress is not route content, so it does not advance the identity — the
   * contract `RouterState` documents, and what lets the adapter overlay
   * `status` onto a publication a component is already presenting.
   */
  test('progress alone does not advance the frame identity', async () => {
    const router = createRouter()
    await router.navigate({ to: '/about' })

    const before = router.stores.__store.get().frameId
    router.stores.status.set('pending')
    const during = router.stores.__store.get()
    router.stores.status.set('idle')

    expect(during.frameId).toBe(before)
    expect(during.status).toBe('pending')
    expect(during.isLoading).toBe(true)
  })

  test('a frame is a complete, self-consistent snapshot', async () => {
    const router = createRouter()
    await router.navigate({ to: '/posts/123' })

    const frame = router.stores.__store.get()

    // Everything a consumer can read comes from the one snapshot, so a frame
    // can never mix slices from different navigations.
    expect(frame.location.pathname).toBe('/posts/123')
    expect(frame.matches.map((match) => match.routeId)).toEqual([
      '__root__',
      '/posts/$postId',
    ])
    expect(frame.status).toBe('idle')
    expect(frame.isLoading).toBe(false)
  })

  test('matchRoute matches against a presented frame, not the head location', async () => {
    const router = createRouter()
    await router.navigate({ to: '/about' })
    const presented = router.stores.__store.get()

    await router.navigate({ to: '/posts/123' })

    // The head has moved on, but a render presenting the older frame must
    // still resolve links and active state against what it is showing.
    expect(router.matchRoute({ to: '/posts/$postId' } as any)).toBeTruthy()
    expect(
      router.matchRoute({ to: '/about' } as any, { _state: presented } as any),
    ).toBeTruthy()
    expect(
      router.matchRoute(
        { to: '/posts/$postId' } as any,
        {
          _state: presented,
        } as any,
      ),
    ).toBe(false)
  })

  test('an explicit pending query resolves against the head, not the frame', async () => {
    const gate = deferred()
    const rootRoute = new BaseRootRoute({})
    const indexRoute = new BaseRoute({
      getParentRoute: () => rootRoute,
      path: '/',
    })
    const slowRoute = new BaseRoute({
      getParentRoute: () => rootRoute,
      path: '/slow',
      loader: () => gate.promise,
    })
    const router = createTestRouter({
      routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    await router.load()

    // The frame the still-visible route is presenting: `/`, not `/slow`.
    const presented = router.stores.__store.get()

    const navigation = router.navigate({ to: '/slow' })
    await vi.waitFor(() => expect(router.stores.status.get()).toBe('pending'))

    // `pending: true` asks about the navigation in flight. A destination-aware
    // indicator rendered by the route still on screen presents the older frame,
    // but must still recognise where the router is going — it only ever renders
    // before the commit, so resolving this against the presented frame would
    // mean it could never light up at all.
    expect(
      router.matchRoute(
        { to: '/slow' } as any,
        {
          _state: presented,
          pending: true,
        } as any,
      ),
    ).toBeTruthy()

    // Ordinary matching still follows what is on screen.
    expect(
      router.matchRoute({ to: '/slow' } as any, { _state: presented } as any),
    ).toBe(false)

    gate.resolve()
    await navigation
  })

  test('a presented match target inherits search from the presented frame', async () => {
    const gate = deferred()
    const rootRoute = new BaseRootRoute({})
    const postsRoute = new BaseRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      validateSearch: (search: Record<string, unknown>) => ({
        tab: (search.tab as string | undefined) ?? 'a',
      }),
      // Only the second tab is slow, so the initial load settles and the
      // navigation away can be held open.
      loaderDeps: ({ search }: any) => ({ tab: search.tab }),
      loader: ({ deps }: any) =>
        deps.tab === 'b' ? gate.promise : Promise.resolve(),
    })
    const router = createTestRouter({
      routeTree: rootRoute.addChildren([postsRoute]),
      history: createMemoryHistory({ initialEntries: ['/posts?tab=a'] }),
    })
    await router.load()

    // The frame the visible route is presenting: `/posts?tab=a`.
    const presented = router.stores.__store.get()
    expect(presented.location.search).toMatchObject({ tab: 'a' })

    // Move the head to the same route with a different search, and hold it.
    const navigation = router.navigate({ to: '/posts', search: { tab: 'b' } })
    await vi.waitFor(() =>
      expect(router.latestLocation.search).toMatchObject({ tab: 'b' }),
    )

    // A link to the route actually on screen that inherits the current search.
    // The target has to inherit `tab` from the frame it will be compared
    // against, not from the head — otherwise the visible route reports itself
    // inactive. (A destination that simply omits `search` builds an empty
    // search and compares partially, so only inheriting callers can see this.)
    expect(
      router.matchRoute(
        { to: '/posts', search: true } as any,
        {
          _state: presented,
        } as any,
      ),
    ).toBeTruthy()

    gate.resolve()
    await navigation
  })


  test('a staged frame matches its own destination before acknowledgement', async () => {
    const gate = deferred()
    const rootRoute = new BaseRootRoute({})
    const indexRoute = new BaseRoute({
      getParentRoute: () => rootRoute,
      path: '/',
    })
    const nextRoute = new BaseRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      loader: () => gate.promise,
    })
    const router = createTestRouter({
      routeTree: rootRoute.addChildren([indexRoute, nextRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    await router.load()

    const navigation = router.navigate({ to: '/next' })
    await vi.waitFor(() =>
      expect(router.latestLocation.pathname).toBe('/next'),
    )

    // The successor as a render would present it: its own location is the
    // destination, while `resolvedLocation` still names the route being left.
    const staged = router.stores.__store.get()
    expect(staged.location.pathname).toBe('/next')

    // A destination-aware `useMatchRoute` in the successor tree renders before
    // acknowledgement. Matching against the frame's stale `resolvedLocation`
    // would report the very route it is presenting as inactive.
    expect(
      router.matchRoute({ to: '/next' } as any, { _state: staged } as any),
    ).toBeTruthy()

    gate.resolve()
    await navigation
  })
})
