import * as React from 'react'
import { isNotFound } from '@tanstack/router-core'
import { isServer } from '@tanstack/router-core/isServer'
import { useStore } from '@tanstack/react-store'
import { CatchBoundary } from './CatchBoundary'
import { useRouter } from './useRouter'
import { useRouterStateSelector } from './routerStateContext'
import type { ErrorInfo } from 'react'
import type { NotFoundError } from '@tanstack/router-core'

export function CatchNotFound(props: {
  fallback?: (error: NotFoundError) => React.ReactElement
  onCatch?: (error: Error, errorInfo: ErrorInfo) => void
  children: React.ReactNode
}) {
  const router = useRouter()
  let pathname: string
  let status: 'pending' | 'idle'
  if (router.options.experimental_concurrentRenderFrames) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- option is static
    ;[pathname, status] = useRouterStateSelector(
      router,
      (state) => [state.location.pathname, state.status] as const,
      (a, b) => a[0] === b[0] && a[1] === b[1],
    )
  } else if (isServer ?? router.isServer) {
    pathname = router.stores.location.get().pathname
    status = router.stores.status.get()
  } else {
    // TODO: Some way for the user to programmatically reset the not-found boundary?
    // eslint-disable-next-line react-hooks/rules-of-hooks -- condition is static
    pathname = useStore(router.stores.location, (location) => location.pathname)
    // eslint-disable-next-line react-hooks/rules-of-hooks -- condition is static
    status = useStore(router.stores.status, (status) => status)
  }
  const resetKey = `not-found-${pathname}-${status}`

  return (
    <CatchBoundary
      getResetKey={() => resetKey}
      onCatch={(error, errorInfo) => {
        if (isNotFound(error)) {
          props.onCatch?.(error, errorInfo)
        } else {
          throw error
        }
      }}
      errorComponent={({ error }) => {
        if (isNotFound(error)) {
          return props.fallback?.(error)
        } else {
          throw error
        }
      }}
    >
      {props.children}
    </CatchBoundary>
  )
}

export function DefaultGlobalNotFound() {
  return <p>Not Found</p>
}
