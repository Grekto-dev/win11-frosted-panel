const GObject  = imports.gi.GObject;
const Gio      = imports.gi.Gio;
const GLib     = imports.gi.GLib;
const Cinnamon = imports.gi.Cinnamon;
const St       = imports.gi.St;

const GTYPE_SUFFIX = Math.floor(Math.random() * 1000000);
const SHADER_CACHE = {};

const SNIPPET_CODE =
    'effect_base_main();\n' +
    'cogl_color_out.rgb /= max(cogl_color_out.a, 0.0001);\n';

function loadShaderSnippet(extensionPath, filename) {
    const key = `${extensionPath}:${filename}`;
    if (SHADER_CACHE[key])
        return SHADER_CACHE[key];

    const path = GLib.build_filenamev([extensionPath, 'shaders', filename]);
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`Win11FrostedPanel: failed to load shader ${filename}`);
    const source = new TextDecoder().decode(contents) + '\n';
    const splitIdx = source.search(/\bvoid\s+main\s*\(/);
    const declarations = splitIdx === -1
        ? source
        : source.slice(0, splitIdx) + '\n' +
          source.slice(splitIdx).replace(/\bvoid\s+main\s*\(\s*(?:void)?\s*\)/, 'void effect_base_main()');
    SHADER_CACHE[key] = declarations;
    return declarations;
}

function actorInsideStage(actor) {
    const stage = actor ? actor.get_stage() : null;
    if (!stage)
        return true;
    const [ok, box] = actor.get_paint_box();
    if (!ok)
        return true;
    return Math.floor(box.x1) >= 0 && Math.floor(box.y1) >= 0 &&
           Math.ceil(box.x2) <= stage.width && Math.ceil(box.y2) <= stage.height;
}

function extendOffscreenViewport(paintContext, actor) {
    try {
        if (!actor || actorInsideStage(actor))
            return;
        const fb = paintContext.get_framebuffer();
        const [vx, vy, vw, vh] = fb.get_viewport4fv();
        if (!(vw > 0 && vh > 0))
            return;
        const ex = Math.max(0, Math.ceil(vx), Math.ceil(fb.get_width() - (vx + vw)));
        const ey = Math.max(0, Math.ceil(vy), Math.ceil(fb.get_height() - (vy + vh)));
        if (ex === 0 && ey === 0)
            return;
        const newW = vw + 2 * ex;
        const newH = vh + 2 * ey;
        const projection = fb.get_projection_matrix();
        const scale = projection.copy();
        scale.init_identity();
        scale.scale(vw / newW, vh / newH, 1);
        const result = projection.copy();
        result.multiply(scale, projection);
        fb.set_projection_matrix(result);
        fb.set_viewport(vx - ex, vy - ey, newW, newH);
    } catch (e) {
        global.logError(`Win11FrostedTaskbar: viewport extension error: ${e}`);
    }
}

let _extensionPath = null;
function setExtensionPath(path) {
    _extensionPath = path;
}

function createGlslEffectClass(name, shaderFile) {
    return GObject.registerClass({
        GTypeName: `Win11Frosted_${name}_${GTYPE_SUFFIX}`,
    }, class extends Cinnamon.GLSLEffect {
        vfunc_build_pipeline() {
            this._uniformLocs = new Map();
            const declarations = loadShaderSnippet(_extensionPath, shaderFile);
            this.add_glsl_snippet(Cinnamon.SnippetHook.FRAGMENT, declarations, SNIPPET_CODE, true);
        }

        setUniform(uniformName, value) {
            if (!this._uniforms) {
                this._uniforms = new Map();
                this._changed = new Map();
            }
            const num = Number(value);
            if (this._uniforms.get(uniformName) === num)
                return;
            this._uniforms.set(uniformName, num);
            this._changed.set(uniformName, num);
            this.queue_repaint();
        }

        vfunc_pre_paint(paintContext) {
            if (!super.vfunc_pre_paint(paintContext))
                return false;
            extendOffscreenViewport(paintContext, this.get_actor());
            return true;
        }

        vfunc_paint_target(...params) {
            if (this._changed && this._changed.size > 0) {
                if (!this._uniformLocs)
                    this._uniformLocs = new Map();
                if (!this._uniformArg)
                    this._uniformArg = [0];
                for (const [uniformName, value] of this._changed) {
                    let loc = this._uniformLocs.get(uniformName);
                    if (loc === undefined) {
                        loc = this.get_uniform_location(uniformName);
                        this._uniformLocs.set(uniformName, loc);
                    }
                    if (loc >= 0) {
                        this._uniformArg[0] = value;
                        this.set_uniform_float(loc, 1, this._uniformArg);
                    }
                }
                this._changed.clear();
            }
            super.vfunc_paint_target(...params);
        }
    });
}

const BlurDownEffect = createGlslEffectClass('BlurDown', 'blur_down.glsl');
const BlurUpEffect = createGlslEffectClass('BlurUp', 'blur_up.glsl');
const Win11AcrylicEffect = createGlslEffectClass('Acrylic', 'acrylic.glsl');

function desiredPassCount(radius) {
    if (radius <= 0)
        return 0;
    if (radius <= 12)
        return 3;
    if (radius <= 35)
        return 5;
    return 7;
}

function baseOffsetMultiplier(totalPasses) {
    if (totalPasses <= 3)
        return 0.18;
    if (totalPasses <= 5)
        return 0.09;
    return 0.07;
}

function computeBlurMargin(radius, scaleFactor) {
    const total = desiredPassCount(radius);
    if (total === 0)
        return 0;
    const midpoint = Math.floor(total / 2);
    const base = Math.min(radius, 100.0) * baseOffsetMultiplier(total) * scaleFactor;
    let reach = 0;
    for (let i = 0; i < total; i++) {
        if (i <= midpoint)
            reach += 0.5 * base * Math.pow(2.0, i);
        else
            reach += 1.5 * base * Math.pow(2.0, (total - 1) - i);
    }
    return Math.ceil(reach) + 4;
}

var FrostedEffectChain = class FrostedEffectChain {
    constructor(actor) {
        this._actor = actor;
        this._blurPasses = [];
        this._acrylicEffect = null;
        this._passCount = -1;
    }

    update(config, rect, scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor) {
        const passCount = desiredPassCount(config.blurRadius);

        if (passCount !== this._passCount || !this._acrylicEffect) {
            this._rebuildEffects(passCount);
        }

        // Update blur pass uniforms
        const midpoint = Math.floor(passCount / 2);
        const mult = baseOffsetMultiplier(passCount);
        const baseOffset = Math.min(config.blurRadius, 100.0) * mult * scaleFactor;

        for (let i = 0; i < this._blurPasses.length; i++) {
            const eff = this._blurPasses[i];
            const stepMult = (i <= midpoint)
                ? Math.pow(2.0, i)
                : Math.pow(2.0, (passCount - 1) - i);
            eff.setUniform('offset', baseOffset * stepMult);
            eff.setUniform('width', rect.vpW);
            eff.setUniform('height', rect.vpH);
        }

        // ClutterOffscreenEffect pads its offscreen texture (2px top/left, 1px bottom/right),
        // so match Muffin's texture mapping (+3px size, +2px origin) for exact 1px border alignment.
        const ac = this._acrylicEffect;
        ac.setUniform('width', rect.vpW + 3.0);
        ac.setUniform('height', rect.vpH + 3.0);
        ac.setUniform('vis_x', rect.visX + 2.0);
        ac.setUniform('vis_y', rect.visY + 2.0);
        ac.setUniform('vis_w', rect.visW);
        ac.setUniform('vis_h', rect.visH);
        ac.setUniform('stage_x', rect.vpX);
        ac.setUniform('stage_y', rect.vpY);
        ac.setUniform('corner_radius', rect.cornerRadius || 0);
        ac.setUniform('corners_top', rect.cornersTop ? 1.0 : 0.0);
        ac.setUniform('corners_bottom', rect.cornersBottom ? 1.0 : 0.0);

        ac.setUniform('lum_r', config.lumColor.r);
        ac.setUniform('lum_g', config.lumColor.g);
        ac.setUniform('lum_b', config.lumColor.b);
        ac.setUniform('lum_opacity', config.lumOpacity);

        ac.setUniform('tint_r', config.tintColor.r);
        ac.setUniform('tint_g', config.tintColor.g);
        ac.setUniform('tint_b', config.tintColor.b);
        ac.setUniform('tint_opacity', config.tintOpacity);

        ac.setUniform('saturation', config.saturation);
        ac.setUniform('noise_amount', config.noiseIntensity);

        ac.setUniform('border_edge', config.showBorder ? rect.borderEdge : -1.0);
        ac.setUniform('border_r', config.borderColor.r);
        ac.setUniform('border_g', config.borderColor.g);
        ac.setUniform('border_b', config.borderColor.b);
        ac.setUniform('border_opacity', config.showBorder ? config.borderOpacity : 0.0);
    }

    _rebuildEffects(passCount) {
        this._clearEffects();
        this._passCount = passCount;

        // Clutter executes effects outer-to-inner during pre-paint, so the FIRST added
        // effect runs its fragment shader LAST (onto the screen), and the LAST added
        // effect runs FIRST on the raw actor pixels.
        this._acrylicEffect = new Win11AcrylicEffect();
        this._actor.add_effect(this._acrylicEffect);

        const midpoint = Math.floor(passCount / 2);
        const passesInExecOrder = [];
        for (let i = 0; i < passCount; i++) {
            const isDown = (i <= midpoint);
            passesInExecOrder.push(isDown ? new BlurDownEffect() : new BlurUpEffect());
        }
        for (let i = passesInExecOrder.length - 1; i >= 0; i--) {
            this._actor.add_effect(passesInExecOrder[i]);
        }
        this._blurPasses = passesInExecOrder;
    }

    _clearEffects() {
        for (const eff of this._blurPasses) {
            try {
                if (eff.get_actor() === this._actor)
                    this._actor.remove_effect(eff);
            } catch (e) {
                global.logError(`Win11FrostedTaskbar: remove blur pass failed: ${e}`);
            }
        }
        this._blurPasses = [];

        if (this._acrylicEffect) {
            try {
                if (this._acrylicEffect.get_actor() === this._actor)
                    this._actor.remove_effect(this._acrylicEffect);
            } catch (e) {
                global.logError(`Win11FrostedTaskbar: remove acrylic pass failed: ${e}`);
            }
            this._acrylicEffect = null;
        }
        this._passCount = -1;
    }

    destroy() {
        this._clearEffects();
        this._actor = null;
    }
};
