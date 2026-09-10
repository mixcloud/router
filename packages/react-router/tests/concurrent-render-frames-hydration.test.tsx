import * as React from 'react'
import { act } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test } from 'vitest'
import { createMemoryHistory } from '@tanstack/history'
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '../src'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!()
  }
  document.body.innerHTML = ''
})

/**
 * The wrapper at the root of the route tree decides an element *type*, so it
 * must not depend on anything that changes under a mounted tree. Keyed on
 * hydration it flipped from a fragment to a `Suspense` boundary the moment
 * hydration finished, and React reads a changed type as a replacement: the
 * whole route subtree unmounted and remounted, re-running mount effects and
 * discarding whatever a component had set up while hydrating.
 */
test('hydration does not remount the route tree', async () => {
  const lifecycle: Array<string> = []

  function IndexPage() {
    React.useEffect(() => {
      lifecycle.push('mount')
      return () => lifecycle.push('unmount')
    }, [])
    return <h1>Index Title</h1>
  }

  const makeRouteTree = () => {
    const rootRoute = createRootRoute({ component: Outlet })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: IndexPage,
    })
    return rootRoute.addChildren([indexRoute])
  }

  const makeRouter = () =>
    createRouter({
      routeTree: makeRouteTree(),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      experimental_concurrentRenderFrames: true,
    })

  const serverRouter = makeRouter()
  serverRouter.isServer = true
  serverRouter.ssr = { manifest: undefined }
  await serverRouter.load()
  const html = renderToString(<RouterProvider router={serverRouter} />)
  expect(html).toContain('Index Title')

  const clientRouter = makeRouter()
  // What the Start SSR client sets on hydration, and what the boundary keys
  // on: an app whose HTML came from the server.
  clientRouter.ssr = { manifest: undefined }
  await clientRouter.load()

  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)

  await act(async () => {
    const root = hydrateRoot(container, <RouterProvider router={clientRouter} />, {
      onRecoverableError: () => {},
    })
    cleanups.push(async () => {
      await act(() => root.unmount())
    })
    await Promise.resolve()
  })

  // Let the hydration flag settle, which is what used to replace the wrapper.
  await act(async () => {
    await Promise.resolve()
  })

  expect(container).toHaveTextContent('Index Title')
  expect(lifecycle).toEqual(['mount'])
})
