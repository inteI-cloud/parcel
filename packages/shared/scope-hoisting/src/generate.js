// @flow

import type {
  Asset,
  BundleGraph,
  NamedBundle,
  PluginOptions,
} from '@parcel/types';
import type {
  ArrayExpression,
  ExpressionStatement,
  Identifier,
  File,
  Statement,
} from '@babel/types';

import babelGenerate from '@babel/generator';
import invariant from 'assert';
import {isEntry} from './utils';
import {PromiseQueue} from '@parcel/utils';
import SourceMap from '@parcel/source-map';
import * as t from '@babel/types';
import template from '@babel/template';

const REGISTER_TEMPLATE = template.statement<
  {|
    REFERENCED_IDS: ArrayExpression,
    STATEMENTS: Array<Statement>,
    PARCEL_REQUIRE: Identifier,
  |},
  ExpressionStatement,
>(`(function() {
  function $parcel$bundleWrapper() {
    if ($parcel$bundleWrapper._executed) return;
    STATEMENTS;
    $parcel$bundleWrapper._executed = true;
  }
  var $parcel$referencedAssets = REFERENCED_IDS;
  for (var $parcel$i = 0; $parcel$i < $parcel$referencedAssets.length; $parcel$i++) {
    PARCEL_REQUIRE.registerBundle($parcel$referencedAssets[$parcel$i], $parcel$bundleWrapper);
  }
})()`);
const WRAPPER_TEMPLATE = template.statement<
  {|STATEMENTS: Array<Statement>|},
  ExpressionStatement,
>('(function () { STATEMENTS; })()');

export async function generate({
  bundleGraph,
  bundle,
  ast,
  referencedAssets,
  parcelRequireName,
  options,
}: {|
  bundleGraph: BundleGraph<NamedBundle>,
  bundle: NamedBundle,
  ast: File,
  options: PluginOptions,
  referencedAssets: Set<Asset>,
  parcelRequireName: string,
|}): Promise<{|contents: string, map: ?SourceMap|}> {
  let interpreter;
  let mainEntry = bundle.getMainEntry();
  if (mainEntry && !bundle.target.env.isBrowser()) {
    let _interpreter = mainEntry.meta.interpreter;
    invariant(_interpreter == null || typeof _interpreter === 'string');
    interpreter = _interpreter;
  }

  let isAsync = !isEntry(bundle, bundleGraph);

  // Wrap async bundles in a closure and register with parcelRequire so they are executed
  // at the right time (after other bundle dependencies are loaded).
  let statements = ast.program.body;
  if (bundle.env.outputFormat === 'global') {
    statements = isAsync
      ? [
          REGISTER_TEMPLATE({
            STATEMENTS: statements,
            REFERENCED_IDS: t.arrayExpression(
              [mainEntry, ...referencedAssets]
                .filter(Boolean)
                .map(asset =>
                  t.stringLiteral(bundleGraph.getAssetPublicId(asset)),
                ),
            ),
            PARCEL_REQUIRE: t.identifier(parcelRequireName),
          }),
        ]
      : [WRAPPER_TEMPLATE({STATEMENTS: statements})];
  }

  ast = t.file(
    t.program(
      statements,
      [],
      bundle.env.outputFormat === 'esmodule' ? 'module' : 'script',
      interpreter ? t.interpreterDirective(interpreter) : null,
    ),
  );

  let {code, rawMappings} = babelGenerate(ast, {
    sourceMaps: !!bundle.env.sourceMap,
    minified: bundle.env.minify,
    comments: true, // retain /*@__PURE__*/ comments for terser
  });

  let map = null;
  if (bundle.env.sourceMap && rawMappings != null) {
    map = new SourceMap(options.projectRoot);
    map.addIndexedMappings(rawMappings);

    // Traverse the bundle to get the sourcecontents
    // this is hella slow but is currently the only way to ensure correct source contents
    let promiseQueue = new PromiseQueue({maxConcurrent: 50});
    bundle.traverseAssets(asset => {
      promiseQueue.add(async () => {
        // Why is map always undefined?
        let map = await asset.getMap();
        if (map) {
          // TODO: Add a faster way to get all sourceContents and their sourcePath in the sourcemaps library?
          let vlqEncodedMap = map.toVLQ();
          if (vlqEncodedMap.sourcesContent) {
            for (let i = 0; i < vlqEncodedMap.sourcesContent.length; i++) {
              let sourceContent = vlqEncodedMap.sourcesContent[i];

              // null = empty string in this case as converting was too slow for it's use-case
              if (sourceContent) {
                let sourceFilePath = vlqEncodedMap.sources[i];
                map.setSourceContent(sourceFilePath, sourceContent);
                console.log('setSourceContent', sourceFilePath);
              }
            }
          }
        }
      });
    });
    await promiseQueue.run();
  }

  return {
    contents: code,
    map,
  };
}
