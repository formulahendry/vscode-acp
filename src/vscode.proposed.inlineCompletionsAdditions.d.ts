/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for
 *  license information.
 *--------------------------------------------------------------------------------------------*/

// Subset of vscode.proposed.inlineCompletionsAdditions.d.ts
// Source: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts
// Only the types needed for NES inline edit support are included.

declare module 'vscode' {

	export interface InlineCompletionItem {
		/** If set to `true`, this item is treated as inline edit (supports multi-line ranges). */
		isInlineEdit?: boolean;

		/**
		 * A range specifying when the edit can be shown based on the cursor position.
		 * If the cursor is within this range, the inline edit can be displayed.
		 */
		showRange?: Range;

		/** Where to place the cursor after accepting the inline edit. */
		jumpToPosition?: Position;
	}
}
