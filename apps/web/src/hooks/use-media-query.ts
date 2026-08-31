import * as React from 'react';

/**
 * A live answer to one media query. The first render says false on the
 * server and on the client alike, then the effect corrects it -- the same
 * shape as useIsMobile, generalised to any breakpoint.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => {
      setMatches(mql.matches);
    };
    mql.addEventListener('change', onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
