/**
 * Fingerprint устройства на основе WebGL.
 * Вариант Б: префикс «full:» / «basic:» + vendor|renderer.
 */
export function getWebGLFingerprint() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return 'no-webgl';

        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (!dbg) {
            const vendor   = gl.getParameter(gl.VENDOR)   || '';
            const renderer = gl.getParameter(gl.RENDERER) || '';
            return `basic:${vendor}|${renderer}`;
        }

        const vendor   = gl.getParameter(gl.VENDOR) || '';
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
        return `full:${vendor}|${renderer}`;
    } catch (e) {
        return 'webgl-error';
    }
}