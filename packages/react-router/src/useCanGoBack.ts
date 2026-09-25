import { useSelector } from '@tanstack/react-store'
import { isServer } from '@tanstack/router-core/isServer'
import { useRouter } from './useRouter'

/**
 * Whether the browser can go back, which is not presented route content.
 *
 * Deliberately reads the head rather than the publication this position is
 * presenting, and so is an exception to the rule the rest of this adapter
 * follows. `history.back()` acts on the browser's history, not on the frame
 * on screen, so the answer has to describe the history the button would
 * actually move. During a staged navigation the two disagree: a push from
 * index 0 leaves the presented frame at 0 while the entry is already there to
 * pop, and a pending pop to index 0 leaves it at 1 — where a back control
 * would fire a second pop and leave the application.
 */
export function useCanGoBack() {
  const router = useRouter()

  if (isServer ?? router.isServer) {
    return router.stores.location.get().state.__TSR_index !== 0
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- condition is static
  return useSelector(
    router.stores.location,
    (location) => location.state.__TSR_index !== 0,
  )
}
