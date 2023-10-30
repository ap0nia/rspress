import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { HelmetData } from 'react-helmet-async';
import chalk from '@modern-js/utils/chalk';
import fs from '@modern-js/utils/fs-extra';
import {
  PageData,
  UserConfig,
  APPEARANCE_KEY,
  normalizeSlash,
  withBase,
} from '@rspress/shared';
import { logger } from '@rspress/shared/logger';
import {
  OUTPUT_DIR,
  APP_HTML_MARKER,
  HEAD_MARKER,
  HTML_START_TAG,
  BODY_START_TAG,
  PUBLIC_DIR,
  TEMP_DIR,
} from './constants';
import { initRsbuild } from './initRsbuild';
import { writeSearchIndex } from './searchIndex';
import { PluginDriver } from './PluginDriver';
import type { Route } from '@/node/route/RouteService';
import { routeService } from '@/node/route/init';

// In the first render, the theme will be set according to the user's system theme
const CHECK_DARK_LIGHT_SCRIPT = `
<script id="check-dark-light">
;(() => {
  const saved = localStorage.getItem('${APPEARANCE_KEY}')
  const prefereDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  if (!saved || saved === 'auto' ? prefereDark : saved === 'dark') {
    document.documentElement.classList.add('dark')
  }
})()
</script>
`;

interface BuildOptions {
  appDirectory: string;
  docDirectory: string;
  config: UserConfig;
}

export async function bundle(
  docDirectory: string,
  config: UserConfig,
  pluginDriver: PluginDriver,
  enableSSG: boolean,
) {
  try {
    const outputDir = config?.outDir ?? OUTPUT_DIR;
    if (enableSSG) {
      const [clientBuilder, ssrBuilder] = await Promise.all([
        initRsbuild(docDirectory, config, pluginDriver, false),
        initRsbuild(docDirectory, config, pluginDriver, true, {
          output: {
            distPath: {
              root: `${outputDir}/ssr`,
            },
          },
        }),
      ]);
      await Promise.all([clientBuilder.build(), ssrBuilder.build()]);
    } else {
      // Only build client bundle
      const clientBuilder = await initRsbuild(
        docDirectory,
        config,
        pluginDriver,
        false,
      );
      await clientBuilder.build();
    }
    // Copy public dir to output folder
    const publicDir = join(docDirectory, PUBLIC_DIR);
    if (await fs.pathExists(publicDir)) {
      await fs.copy(publicDir, outputDir);
    }
  } finally {
    await writeSearchIndex(config);
  }
}

export interface SSRBundleExports {
  render: (
    url: string,
    helmetContext: object,
  ) => Promise<{ appHtml: string; pageData: PageData }>;
  routes: Route[];
}

export async function renderPages(
  appDirectory: string,
  config: UserConfig,
  pluginDriver: PluginDriver,
  enableSSG: boolean,
) {
  logger.info('Rendering pages...');
  const startTime = Date.now();
  const outputPath = config?.outDir ?? join(appDirectory, OUTPUT_DIR);
  const ssrBundlePath = join(outputPath, 'ssr', 'bundles', 'main.js');
  try {
    const { default: fs } = await import('@modern-js/utils/fs-extra');
    // There are two cases where we will fallback to CSR:
    // 1. ssr bundle load failed
    // 2. ssr bundle render failed
    // 3. ssg is disabled
    let render = null;
    if (enableSSG) {
      try {
        const { default: ssrExports } = await import(
          pathToFileURL(ssrBundlePath).toString()
        );
        ({ render } = ssrExports as SSRBundleExports);
      } catch (e) {
        logger.error(e);
        logger.warn(
          `Failed to load SSR bundle: ${ssrBundlePath}, fallback to CSR.`,
        );
        // fallback to csr
      }
    }

    const routes = routeService.getRoutes();
    const base = config?.base ?? '';

    // Get the html generated by builder, as the default ssr template
    const htmlTemplatePath = join(outputPath, 'html', 'main', 'index.html');
    const htmlTemplate = await fs.readFile(htmlTemplatePath, 'utf-8');
    const additionalRoutes = (await pluginDriver.addSSGRoutes()).map(route => ({
      routePath: withBase(route.path, base),
    }));
    await Promise.all(
      [...routes, ...additionalRoutes]
        .filter(route => {
          // filter the route including dynamic params
          return !route.routePath.includes(':');
        })
        .map(async route => {
          const helmetContext: HelmetData = {
            context: {},
          } as HelmetData;
          const { routePath } = route;
          let appHtml = '';
          if (render) {
            try {
              ({ appHtml } = await render(routePath, helmetContext.context));
            } catch (e) {
              logger.warn(
                `page "${routePath}" render error: ${e.message}, fallback to CSR.`,
              );
              // fallback to csr
            }
          }

          const { helmet } = helmetContext.context;
          let html = htmlTemplate
            // Don't use `string` as second param
            // To avoid some special characters transformed to the marker, such as `$&`, etc.
            .replace(APP_HTML_MARKER, () => appHtml)
            .replace(
              HEAD_MARKER,
              (config?.head || [])
                .concat([
                  helmet?.title?.toString(),
                  helmet?.meta?.toString(),
                  helmet?.link?.toString(),
                  helmet?.style?.toString(),
                  helmet?.script?.toString(),
                  CHECK_DARK_LIGHT_SCRIPT,
                ])
                .join(''),
            );
          if (helmet?.htmlAttributes) {
            html = html.replace(
              HTML_START_TAG,
              `${HTML_START_TAG} ${helmet?.htmlAttributes?.toString()}`,
            );
          }

          if (helmet?.bodyAttributes) {
            html = html.replace(
              BODY_START_TAG,
              `${BODY_START_TAG} ${helmet?.bodyAttributes?.toString()}`,
            );
          }

          const normalizeHtmlFilePath = (path: string) => {
            const normalizedBase = normalizeSlash(config?.base || '/');

            if (path.endsWith('/')) {
              return `${path}index.html`.replace(normalizedBase, '');
            }

            return `${path}.html`.replace(normalizedBase, '');
          };
          const fileName = normalizeHtmlFilePath(routePath);
          await fs.ensureDir(join(outputPath, dirname(fileName)));
          await fs.writeFile(join(outputPath, fileName), html);
        }),
    );
    // Remove ssr bundle
    await fs.remove(join(outputPath, 'ssr'));
    await fs.remove(join(outputPath, 'html'));

    const totalTime = Date.now() - startTime;
    logger.success(`Pages rendered in ${chalk.yellow(totalTime)} ms.`);
  } catch (e) {
    logger.error(`Pages render error: ${e.stack}`);
    throw e;
  }
}

export async function build(options: BuildOptions) {
  const { docDirectory, appDirectory, config } = options;
  const pluginDriver = new PluginDriver(config, true);
  const enableSSG = config.ssg ?? true;
  await pluginDriver.init();
  const modifiedConfig = await pluginDriver.modifyConfig();
  await pluginDriver.beforeBuild();

  // empty temp dir before build
  await fs.emptyDir(TEMP_DIR);

  await bundle(docDirectory, modifiedConfig, pluginDriver, enableSSG);
  await renderPages(appDirectory, modifiedConfig, pluginDriver, enableSSG);
  await pluginDriver.afterBuild();
}
