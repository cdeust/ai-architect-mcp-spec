/**
 * precondition:  `runtimeDir` is the directory of the running entry point.
 * postcondition: `env.CLAUDE_PLUGIN_ROOT` when it is set; otherwise the
 *                nearest directory, among `runtimeDir` and the two above it,
 *                that holds `packages/skill`; otherwise the directory three
 *                levels above `runtimeDir`, as before, so that a layout with
 *                no `packages/skill` resolves to what it resolved to.
 */
export declare function resolvePluginRoot(runtimeDir: string, env: {
    readonly CLAUDE_PLUGIN_ROOT?: string;
}, exists?: (path: string) => boolean): string;
//# sourceMappingURL=plugin-root.d.ts.map