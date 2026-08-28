import { describe, expect, test } from 'vitest'
import { createMemoryHistory } from '@tanstack/history'
import { BaseRootRoute, BaseRoute } from '../src'
import { createTestRouter } from './routerTestUtils'

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
})
