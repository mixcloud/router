'use client'

import * as React from 'react'
import { useStore } from '@tanstack/react-store'
import { isServer } from '@tanstack/router-core/isServer'
import { useLayoutEffect } from './utils'
import type { AnyRouter, RouterState } from '@tanstack/router-core'

export type RouterRenderFrame = RouterState<any>

type RouterStateContextValue = {
  router: AnyRouter
  frame: RouterRenderFrame
  begin: () => void
  stage: (frame: RouterRenderFrame) => RouterRenderFrame
  cancel: () => void
  commit: (frame: RouterRenderFrame) => boolean
}

const defaultCompare = (a: unknown, b: unknown) => a === b

const routerStateContext = React.createContext<
  RouterStateContextValue | undefined
>(undefined)

export function RouterStateProvider({
  router,
  children,
}: {
  router: AnyRouter
  children: React.ReactNode
}) {
  const staging = React.useRef(false)
  const pendingFrame = React.useRef<RouterRenderFrame | undefined>(undefined)
  const [frame, setFrame] = React.useState<RouterRenderFrame>(() =>
    router.stores.__store.get(),
  )

  const publish = React.useCallback(() => {
    if (staging.current || pendingFrame.current) {
      return
    }
    const nextFrame = router.stores.__store.get()
    if (nextFrame.status === 'pending') {
      return
    }
    setFrame((previous) =>
      previous.frameId === nextFrame.frameId ? previous : nextFrame,
    )
  }, [router])

  const begin = React.useCallback(() => {
    staging.current = true
  }, [])

  const stage = React.useCallback((nextFrame: RouterRenderFrame) => {
    staging.current = false
    pendingFrame.current = nextFrame
    return nextFrame
  }, [])

  const cancel = React.useCallback(() => {
    staging.current = false
    pendingFrame.current = undefined
    publish()
  }, [publish])

  const commit = React.useCallback((nextFrame: RouterRenderFrame) => {
    if (pendingFrame.current?.frameId !== nextFrame.frameId) {
      return false
    }
    pendingFrame.current = undefined
    setFrame(nextFrame)
    return true
  }, [])

  useLayoutEffect(() => {
    const subscription = router.stores.__store.subscribe(() => publish())
    publish()
    return () => subscription.unsubscribe()
  }, [publish, router])

  const value = React.useMemo(
    () => ({ router, frame, begin, stage, cancel, commit }),
    [router, frame, begin, stage, cancel, commit],
  )

  return (
    <routerStateContext.Provider value={value}>
      {children}
    </routerStateContext.Provider>
  )
}

export function RouterStateFrame({
  frame,
  children,
}: {
  frame: RouterRenderFrame
  children: React.ReactNode
}) {
  const owner = React.useContext(routerStateContext)!
  const value = React.useMemo(() => ({ ...owner, frame }), [owner, frame])
  return (
    <routerStateContext.Provider value={value}>
      {children}
    </routerStateContext.Provider>
  )
}

export function useRouterStateOwner() {
  return React.useContext(routerStateContext)
}

export function useRouterStateSelector<TSelected>(
  router: AnyRouter,
  selector: (state: RouterState<any>) => TSelected,
  compare: (a: TSelected, b: TSelected) => boolean = defaultCompare,
): TSelected {
  const context = React.useContext(routerStateContext)
  const contextState = context?.router === router ? context.frame : null
  const selection = React.useRef<{ value: TSelected } | undefined>(undefined)

  if (contextState) {
    const next = selector(contextState)
    if (!selection.current || !compare(selection.current.value, next)) {
      selection.current = { value: next }
    }
    return selection.current.value
  }

  if (isServer ?? router.isServer) {
    return selector(router.stores.__store.get())
  }

  // The frame option is fixed when the router is created, so this branch
  // cannot change hook order during the lifetime of a mounted router.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStore(router.stores.__store, selector, compare)
}
