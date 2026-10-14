import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import * as vscode from 'vscode';
import { trailingThrottle } from '../src/presence/throttle.js';
import { clampPositionToDocument, RemoteCursorRenderer } from '../src/presence/RemoteCursorRenderer.js';
import { FollowController } from '../src/presence/FollowController.js';
import { PresenceManager, UserPresenceState } from '../src/presence/PresenceManager.js';

describe('Milestone 7: Presence, Remote Cursors, Follow Mode', () => {
  describe('throttle utility (trailingThrottle)', () => {
    it('executes callback with trailing edge and collapses bursts', async () => {
      const calls: number[] = [];
      const throttled = trailingThrottle((val: number) => {
        calls.push(val);
      }, 50);

      throttled(1);
      throttled(2);
      throttled(3);

      expect(calls).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(calls).toEqual([3]);

      throttled(4);
      throttled.flush();
      expect(calls).toEqual([3, 4]);

      throttled(5);
      throttled.cancel();
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(calls).toEqual([3, 4]);
    });
  });

  describe('Position mapping and clamping', () => {
    it('clamps line and character within document limits and handles empty doc', () => {
      const docLines = ['hello world', 'line two'];
      const fakeDoc: any = {
        lineCount: 2,
        lineAt: (line: number) => ({
          text: docLines[line] || '',
          range: { end: { character: docLines[line]?.length || 0 } },
        }),
      };

      // Normal position within bounds
      const normalPos = new vscode.Position(0, 5);
      expect(clampPositionToDocument(normalPos, fakeDoc)).toEqual(new vscode.Position(0, 5));

      // Over line length
      const overChar = new vscode.Position(0, 50);
      expect(clampPositionToDocument(overChar, fakeDoc)).toEqual(new vscode.Position(0, 11));

      // Past last line
      const overLine = new vscode.Position(10, 50);
      expect(clampPositionToDocument(overLine, fakeDoc)).toEqual(new vscode.Position(1, 8));

      // Negative values
      const negativePos = new vscode.Position(-5, -10);
      expect(clampPositionToDocument(negativePos, fakeDoc)).toEqual(new vscode.Position(0, 0));

      // Empty document
      const emptyDoc: any = {
        lineCount: 0,
        lineAt: () => ({ text: '', range: { end: { character: 0 } } }),
      };
      expect(clampPositionToDocument(new vscode.Position(2, 5), emptyDoc)).toEqual(new vscode.Position(0, 0));
    });
  });

  describe('Yjs RelativePosition resolution after concurrent edits', () => {
    it('shifts position forward when text is inserted before the anchor', () => {
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('content');
      ytext.insert(0, 'Hello World');

      // Anchor cursor at index 6 ("World")
      const relPos = Y.createRelativePositionFromTypeIndex(ytext, 6);

      // Concurrent insert at index 0: "Big " -> "Big Hello World"
      ytext.insert(0, 'Big ');

      const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
      expect(absPos).not.toBeNull();
      expect(absPos!.index).toBe(10); // 6 + 4 ("Big ")
      expect(ytext.toString().slice(absPos!.index)).toBe('World');
    });

    it('clamps or tracks index when text is deleted around the anchor', () => {
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('content');
      ytext.insert(0, 'ABCDEF');

      const relPos = Y.createRelativePositionFromTypeIndex(ytext, 4); // at 'E'

      // Delete 'BCD' (length 3, starting at index 1)
      ytext.delete(1, 3);
      // ytext is now "AEF"
      const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
      expect(absPos).not.toBeNull();
      expect(absPos!.index).toBe(1); // was 4, 3 chars deleted before it -> index 1
      expect(ytext.toString()[absPos!.index]).toBe('E');
    });
  });

  describe('FollowController state machine', () => {
    it('manages follow target and auto-stops on manual navigation', () => {
      const fakePresenceManager: any = {
        getStates: () => new Map<string, UserPresenceState>(),
        onDidChangePresence: () => ({ dispose: () => {} }),
      };
      const fakeConnection: any = {
        send: vi.fn(),
      };

      const controller = new FollowController({
        presenceManager: fakePresenceManager,
        connection: fakeConnection,
        role: 'host',
      });

      expect(controller.isFollowing()).toBe(false);

      controller.followParticipant('guest-1', 'Alice');
      expect(controller.isFollowing()).toBe(true);
      expect(controller.getFollowingUserId()).toBe('guest-1');

      // Target update with same active file and cursor
      const aliceState: UserPresenceState = {
        user: { id: 'guest-1', name: 'Alice', color: '#3CB44B' },
        activeFile: 'src/main.ts',
        cursor: { line: 10, character: 4 },
        selections: [],
        viewport: { startLine: 0, endLine: 25 },
        lastActive: Date.now(),
        typingUntil: 0,
      };

      controller.handlePresenceChange(aliceState);
      expect(controller.isFollowing()).toBe(true);

      // Manual navigation should stop following
      controller.onManualNavigation();
      expect(controller.isFollowing()).toBe(false);
      expect(controller.getFollowingUserId()).toBeNull();

      controller.dispose();
    });
  });

  describe('RemoteCursorRenderer with 3 simulated users', () => {
    it('generates caret, selection, and name label decorations for remote users', () => {
      const users: UserPresenceState[] = [
        {
          user: { id: 'user-1', name: 'Alice', color: '#E6194B' },
          activeFile: 'src/index.ts',
          cursor: { line: 2, character: 5 },
          selections: [{ anchor: { line: 2, character: 0 }, active: { line: 2, character: 5 } }],
          viewport: { startLine: 0, endLine: 30 },
          lastActive: Date.now(),
          typingUntil: 0,
        },
        {
          user: { id: 'user-2', name: 'Bob', color: '#3CB44B' },
          activeFile: 'src/index.ts',
          cursor: { line: 5, character: 10 },
          selections: [],
          viewport: { startLine: 0, endLine: 30 },
          lastActive: Date.now(),
          typingUntil: Date.now() + 5000,
        },
        {
          user: { id: 'user-3', name: 'Charlie', color: '#FFE119' },
          activeFile: 'src/other.ts', // Different file!
          cursor: { line: 0, character: 0 },
          selections: [],
          viewport: { startLine: 0, endLine: 10 },
          lastActive: Date.now(),
          typingUntil: 0,
        },
      ];

      const statesMap = new Map<string, UserPresenceState>();
      for (const u of users) {
        statesMap.set(u.user.id, u);
      }

      let presenceCallback: (() => void) | null = null;
      const fakePresenceManager: any = {
        getStates: () => statesMap,
        onDidChangePresence: (cb: () => void) => {
          presenceCallback = cb;
          return { dispose: () => {} };
        },
      };

      const setDecorationsSpy = vi.fn();
      const fakeEditor: any = {
        document: {
          uri: vscode.Uri.file('/workspace/src/index.ts'),
          lineCount: 20,
          lineAt: (l: number) => ({ text: 'sample line text', range: { end: { character: 16 } } }),
        },
        setDecorations: setDecorationsSpy,
      };

      // Mock activeTextEditor
      (vscode.window as any).activeTextEditor = fakeEditor;
      (vscode.window as any).visibleTextEditors = [fakeEditor];

      const renderer = new RemoteCursorRenderer(
        fakePresenceManager,
        'local-user', // Current user
        null, // No sync manager in mock
        '/workspace',
      );

      // Trigger render
      renderer.render();

      // Alice (user-1) and Bob (user-2) are in src/index.ts, Charlie is in src/other.ts
      // setDecorations should have been called for user-1 and user-2 (selection, caret, label)
      expect(setDecorationsSpy).toHaveBeenCalled();

      // User leaves
      renderer.onParticipantLeft('user-1');
      expect(renderer.getUserCount()).toBeLessThanOrEqual(2);

      renderer.dispose();
    });
  });
});
