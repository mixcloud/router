import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import './styles.css'

// Set up a Router instance
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultStaleTime: 5000,
  scrollRestoration: true,
  /* 
  Using defaultViewTransition would prevent the need to
  manually add `viewTransition: true` to every navigation.

  If defaultViewTransition.types is a function, it will be called with the
  location change info and should return an array of view transition types.
  This is useful if you want to have different view transitions depending on
  the navigation's specifics.

  An example use case is sliding in a direction based on the index of the
  previous and next routes when navigating via browser history back and forth.
  */
  // defaultViewTransition: true
  // OR
  // defaultViewTransition: {
  //   types: ({ fromLocation, toLocation }) => {
  //     let direction = 'none'

  //     if (fromLocation) {
  //       const fromIndex = fromLocation.state.__TSR_index
  //       const toIndex = toLocation.state.__TSR_index

  //       direction = fromIndex > toIndex ? 'right' : 'left'
  //     }

  //     return [`slide-${direction}`]
  //   },
  // },

  // Run this fixture on the render-frame path, so its tests act as a
  // regression guard that the option does not break `viewTransition: true`.
  //
  // They do not, and cannot, prove the option's own behaviour: they assert on
  // `document.startViewTransition`, which `viewTransition: true` calls
  // directly, and they pass with the option either way (verified). React's
  // `<ViewTransition>` — what the option actually unblocks — is canary-only,
  // so it cannot be exercised on the React version this repo pins. The unit
  // tests cover the protocol; see the PR for the measured evidence.
  experimental_concurrentRenderFrames: true,
})

// Register things for typesafety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(<RouterProvider router={router} />)
}
