import { lazy, Suspense, useEffect, useState } from 'react'
import { Landing } from './Landing.tsx'

const Tool = lazy(() => import('./Tool.tsx'))

export function go(href: string) {
  history.pushState({}, '', href)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
}

export function App() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  if (path === '/app' || path.startsWith('/app/')) {
    return <Suspense fallback={<div className="boot" role="status">Starting the simulator</div>}><Tool /></Suspense>
  }
  return <Landing />
}
