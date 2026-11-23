from pathlib import Path
import argparse
import bpy, cv2, numpy as np
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT / '.codex-work/brand-glass-system-render'
BASE.mkdir(parents=True,exist_ok=True)
parser=argparse.ArgumentParser()
parser.add_argument('--draft',action='store_true')
parser.add_argument('--font',default='C:/Windows/Fonts/msyh.ttc')
args=parser.parse_args()
draft=args.draft
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.device='CPU'
scene.cycles.samples=32 if draft else 96
scene.cycles.use_denoising=True
scene.cycles.max_bounces=12
scene.cycles.transmission_bounces=8
scene.render.threads_mode='FIXED'
scene.render.threads=6
scene.render.resolution_x=1280 if draft else 1920
scene.render.resolution_y=480 if draft else 720
scene.render.resolution_percentage=100
scene.render.film_transparent=True
scene.render.image_settings.file_format='PNG'
scene.render.image_settings.color_mode='RGBA'
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'
scene.view_settings.exposure=0.1
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(0.88,0.96,1,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=0.55

def glass(name,low,high,transmission,roughness):
    m=bpy.data.materials.new(name)
    m.use_nodes=True
    nodes=m.node_tree.nodes
    links=m.node_tree.links
    p=nodes.get('Principled BSDF')
    p.inputs['Transmission Weight'].default_value=transmission
    p.inputs['Roughness'].default_value=roughness
    p.inputs['IOR'].default_value=1.46
    p.inputs['Coat Weight'].default_value=0.32
    p.inputs['Coat Roughness'].default_value=0.10
    p.inputs['Specular IOR Level'].default_value=0.42
    coord=nodes.new('ShaderNodeTexCoord')
    split=nodes.new('ShaderNodeSeparateXYZ')
    ramp=nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position=0.0
    ramp.color_ramp.elements[0].color=(*low,1)
    ramp.color_ramp.elements[1].position=1
    ramp.color_ramp.elements[1].color=(*high,1)
    links.new(coord.outputs['Generated'],split.inputs[0])
    links.new(split.outputs['Y'],ramp.inputs[0])
    links.new(ramp.outputs[0],p.inputs['Base Color'])
    absorb=nodes.new('ShaderNodeVolumeAbsorption')
    absorb.inputs['Color'].default_value=(0.06,0.60,0.87,1)
    absorb.inputs['Density'].default_value=0.35
    links.new(absorb.outputs[0],nodes.get('Material Output').inputs['Volume'])
    return m

blue=glass('Pale aqua frosted glass',(0.015,0.30,0.60),(0.20,0.62,0.88),0.78,0.19)
letter=glass('Readable ice blue letter faces',(0.005,0.18,0.42),(0.035,0.38,0.70),0.45,0.23)
inlay=glass('Translucent brain ribbons',(0.35,0.70,0.85),(0.72,0.91,0.98),0.80,0.20)
source=ROOT/'engines/video-studio/bundled/company-assets/Logo/智慧驱动-透明Logo.png'
img=cv2.imdecode(np.fromfile(source,dtype=np.uint8),cv2.IMREAD_UNCHANGED)[:,:454]
alpha=img[:,:,3]>140
brain=(np.all(img[:,:,:3]>220,axis=2)&alpha)

def contour(name,mask,depth,bevel,z,mat,epsilon):
    smooth=cv2.GaussianBlur(mask.astype(np.uint8)*255,(5,5),0.8)
    contours,_=cv2.findContours((smooth>125).astype(np.uint8)*255,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    curve=bpy.data.curves.new(name,'CURVE')
    curve.dimensions='2D'
    curve.fill_mode='BOTH'
    curve.extrude=depth/2
    for contour in contours:
        if cv2.contourArea(contour)<8: continue
        points=cv2.approxPolyDP(contour,epsilon,True)[:,0,:]
        spline=curve.splines.new('POLY')
        spline.points.add(len(points)-1)
        for p,(x,y) in zip(spline.points,points): p.co=((float(x)-227)/100,(227-float(y))/100,0,1)
        spline.use_cyclic_u=True
    obj=bpy.data.objects.new(name,curve)
    bpy.context.collection.objects.link(obj)
    obj.location=(-5.65,0,z*0.86)
    obj.scale=(0.86,0.86,0.86)
    obj.pass_index=1
    obj.data.materials.append(mat)
    bpy.context.view_layer.objects.active=obj
    obj.select_set(True)
    bpy.ops.object.convert(target='MESH')
    mod=obj.modifiers.new('Rounded glass edge','BEVEL')
    mod.width=bevel
    mod.segments=6
    mod.limit_method='ANGLE'
    mod.angle_limit=0.25
    mod.harden_normals=True
    obj.modifiers.new('Weighted normals','WEIGHTED_NORMAL').keep_sharp=True
    obj.select_set(False)

contour('Company gear',alpha,0.95,0.14,0.52,blue,2.1)
contour('Brain ribbon inlay',brain,0.035,0.016,1.035,inlay,1.0)
font=bpy.data.fonts.load(args.font)
for i,char in enumerate('智慧驱动'):
    curve=bpy.data.curves.new('Letter '+char,'FONT')
    curve.body=char
    curve.font=font
    curve.align_x='CENTER'
    curve.align_y='CENTER'
    curve.size=3.05
    curve.extrude=0.20
    curve.bevel_depth=0.025
    curve.bevel_resolution=5
    curve.resolution_u=16
    obj=bpy.data.objects.new('Letter '+char,curve)
    bpy.context.collection.objects.link(obj)
    obj.location=(-1.8+i*2.65,0,0.41)
    obj.pass_index=1
    obj.data.materials.append(letter)

floor=bpy.data.materials.new('White reflection ground')
floor.use_nodes=True
floor.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(0.93,0.96,1,1)
floor.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=0.5
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-0.04))
bpy.context.object.data.materials.append(floor)
bpy.context.object.is_shadow_catcher=True

def light(name,location,power,size,shape='DISK',size_y=None):
    data=bpy.data.lights.new(name,'AREA')
    data.energy=power
    data.shape=shape
    data.size=size
    if size_y is not None: data.size_y=size_y
    obj=bpy.data.objects.new(name,data)
    bpy.context.collection.objects.link(obj)
    obj.location=location
    obj.rotation_euler=(Vector((0,0,0))-obj.location).to_track_quat('-Z','Y').to_euler()
light('Upper left soft light',(-8,4,9),1500,5)
light('Long rim reflection',(2,4,6),650,10,'RECTANGLE',1.2)
light('Front fill',(3,-7,7),450,7)
cam=bpy.data.cameras.new('Angled brand camera')
obj=bpy.data.objects.new('Angled brand camera',cam)
bpy.context.collection.objects.link(obj)
obj.location=(0,-13,25)
obj.rotation_euler=(Vector((-0.4,0,0.25))-obj.location).to_track_quat('-Z','Y').to_euler()
cam.type='ORTHO'
cam.ortho_scale=17
scene.camera=obj
scene.view_layers[0].use_pass_object_index=True
scene.use_nodes=True
nodes=scene.node_tree.nodes
nodes.clear()
layers=nodes.new('CompositorNodeRLayers')
composite=nodes.new('CompositorNodeComposite')
scene.node_tree.links.new(layers.outputs['Image'],composite.inputs[0])
mask=nodes.new('CompositorNodeOutputFile')
mask.base_path=str(BASE)
mask.format.file_format='PNG'
mask.format.color_mode='BW'
mask.file_slots[0].path='object-mask-'
scene.node_tree.links.new(layers.outputs['IndexOB'],mask.inputs[0])
scene.render.filepath=str(BASE/('draft.png' if draft else 'brand-render.png'))
if not draft: bpy.ops.wm.save_as_mainfile(filepath=str(BASE/'brand.blend'))
bpy.ops.render.render(write_still=True)
print('RENDER_SUCCESS',scene.render.filepath,flush=True)
