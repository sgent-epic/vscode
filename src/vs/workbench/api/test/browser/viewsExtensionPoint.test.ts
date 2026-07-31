/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewsExtensionHandler } from '../../browser/viewsExtensionPoint.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, WindowEnablement } from '../../../common/views.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ExtensionMessageCollector, ExtensionPoint, ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import { workbenchInstantiationService } from '../../../test/browser/workbenchTestServices.js';

suite('ViewsExtensionPoint', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const viewContainersExtensionPoint = ExtensionsRegistry.getExtensionPoints().find(extensionPoint => extensionPoint.name === 'viewsContainers') as ExtensionPoint<unknown>;
	const viewsExtensionPoint = ExtensionsRegistry.getExtensionPoints().find(extensionPoint => extensionPoint.name === 'views') as ExtensionPoint<unknown>;

	setup(() => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		disposables.add(instantiationService.createInstance(ViewsExtensionHandler));
	});

	teardown(() => {
		viewsExtensionPoint.acceptUsers([]);
		viewContainersExtensionPoint.acceptUsers([]);
	});

	test('extension-owned views remain eligible in editor and Sessions windows', () => {
		const description = {
			...nullExtensionDescription,
			identifier: new ExtensionIdentifier('test.sessions-views')
		};
		const collector = new ExtensionMessageCollector(() => { }, description, 'views');

		viewContainersExtensionPoint.acceptUsers([{
			description,
			collector,
			value: {
				panel: [{ id: 'testSessionsPanel', title: 'Test Sessions Panel', icon: 'icon.svg' }]
			}
		}]);
		viewsExtensionPoint.acceptUsers([{
			description,
			collector,
			value: {
				testSessionsPanel: [{ type: 'webview', id: 'test.sessionsView', name: 'Test Sessions View' }]
			}
		}]);

		const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const container = viewContainersRegistry.get('workbench.view.extension.testSessionsPanel');
		const view = viewsRegistry.getView('test.sessionsView');

		assert.strictEqual(container?.windowEnablement, WindowEnablement.Both, 'The extension container must survive the Sessions window filter');
		assert.strictEqual(view?.windowEnablement, WindowEnablement.Both, 'The contributed view must survive the Sessions window filter');
	});
});
