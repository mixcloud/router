import { useStore } from '@tanstack/react-store'
import { isServer } from '@tanstack/router-core/isServer'
import { useRouter } from './useRouter'
import { useRouterStateSelector } from './routerStateContext'

export function useCanGoBack() {
  const router = useRouter()

  if (router.options.experimental_concurrentRenderFrames) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- option is static
    return useRouterStateSelector(
      router,
      (state) => state.location.state.__TSR_index !== 0,
    )
  }

  if (isServer ?? router.isServer) {
    return router.stores.location.get().state.__TSR_index !== 0
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- condition is static
  return useStore(
    router.stores.location,
    (location) => location.state.__TSR_index !== 0,
  )
}
