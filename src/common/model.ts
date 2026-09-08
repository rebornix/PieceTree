/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// From vs/editor/common/model.ts: the reader a text buffer hands out for a
// consistent, incremental read of its whole content.

export interface ITextSnapshot {
	read(): string | null;
}
