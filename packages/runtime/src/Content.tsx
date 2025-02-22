// @ts-expect-error __VIRTUAL_ROUTES__ will be determined at build time
import { routes } from '__VIRTUAL_ROUTES__';
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-require-imports */
import { type ReactElement, type ReactNode, Suspense, memo } from 'react';
import { matchRoutes, useLocation } from 'react-router-dom';
import siteData from 'virtual-site-data';
import { useViewTransition } from './hooks';
import { normalizeRoutePath } from './utils';

function TransitionContentImpl(props: { el: ReactElement }) {
  let element = props.el;
  if (siteData?.themeConfig?.enableContentAnimation) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    element = useViewTransition(props.el);
  }
  return element;
}

const TransitionContent = memo(
  TransitionContentImpl,
  (prevProps, nextProps) => prevProps.el === nextProps.el,
);

export const Content = ({ fallback = <></> }: { fallback?: ReactNode }) => {
  const { pathname } = useLocation();
  const matched = matchRoutes(
    routes as typeof import('virtual-routes')['routes'],
    normalizeRoutePath(pathname),
  );
  if (!matched) {
    return <div></div>;
  }
  const routesElement = matched[0].route.element;

  // React 17 Suspense SSR is not supported
  if (!process.env.__REACT_GTE_18__ && process.env.__SSR__) {
    return routesElement;
  }

  return (
    <Suspense fallback={fallback}>
      <TransitionContent el={routesElement} />
    </Suspense>
  );
};
