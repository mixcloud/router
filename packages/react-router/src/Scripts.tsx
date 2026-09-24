import { useSelector } from '@tanstack/react-store'
import { _getAssetMatches, deepEqual } from '@tanstack/router-core'
import { isServer } from '@tanstack/router-core/isServer'
import { Asset } from './Asset'
import { useRouter } from './useRouter'
import {
  useFrameMode,
  useRouterStateSelector,
} from './routerStateContext'
import type { RouterManagedTag } from '@tanstack/router-core'

type ScriptRenderAsset = RouterManagedTag & {
  preventScriptHoist?: boolean
}

/**
 * Render body script tags collected from route matches and SSR manifests.
 * Should be placed near the end of the document body.
 */
export const Scripts = () => {
  const router = useRouter()
  const nonce = router.options.ssr?.nonce

  const getScripts = (matches: Array<any>) => {
    matches = _getAssetMatches(matches)
    const scripts = matches
      .flatMap((match) => match.scripts ?? [])
      .filter(Boolean)
      .map(
        ({ children, ...script }) =>
          ({
            tag: 'script',
            attrs: {
              ...script,
              suppressHydrationWarning: true,
              nonce,
            },
            children,
          }) satisfies RouterManagedTag,
      ) as Array<ScriptRenderAsset>
    const manifest = router.ssr?.manifest

    if (!manifest) {
      return scripts
    }

    for (const match of matches) {
      const manifestScripts = manifest.routes[match.routeId]?.scripts

      if (!manifestScripts) {
        continue
      }

      for (const asset of manifestScripts) {
        scripts.push({
          tag: 'script',
          attrs: { ...asset.attrs, nonce },
          children: asset.children,
          ...(typeof asset.attrs?.src === 'string'
            ? { preventScriptHoist: true }
            : {}),
        })
      }
    }

    return scripts
  }

  // The server renders once and has no staged successor, so it reads the
  // store head directly, as upstream does.
  if (isServer ?? router.isServer) {
    const activeMatches = router.stores.matches.get()
    const scripts = getScripts(activeMatches)
    return renderScripts(router, scripts)
  }

  // On the client the scripts belong to the publication this tree is
  // presenting, so that a staged navigation does not pull in the
  // destination's scripts while the previous route is still on screen.
  let scripts: ReturnType<typeof getScripts>
  // eslint-disable-next-line react-hooks/rules-of-hooks -- server return above, condition is static
  if (useFrameMode(router)) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- frozen at mount
    scripts = useRouterStateSelector(
      router,
      (state) => getScripts(state.matches),
      deepEqual,
    )
  } else {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- condition is static
    scripts = useSelector(router.stores.matches, getScripts, {
      compare: deepEqual,
    })
  }

  return renderScripts(router, scripts)
}

function renderScripts(
  router: ReturnType<typeof useRouter>,
  scripts: Array<ScriptRenderAsset>,
) {
  if ((isServer ?? router.isServer) && router.serverSsr) {
    const serverBufferedScript = router.serverSsr.takeBufferedScripts()
    if (serverBufferedScript) {
      scripts.unshift(serverBufferedScript)
    }
  }

  return (
    <>
      {scripts.map((asset, i) => (
        <Asset {...asset} key={`tsr-scripts-${asset.tag}-${i}`} />
      ))}
    </>
  )
}
