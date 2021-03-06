
import Cesium = require('cesium');
import fs=require( "fs-extra");
import _=require("lodash")
import fetch from 'node-fetch';
import  dataUriToBuffer = require('data-uri-to-buffer');
import { Buffer } from 'buffer';
import { SrvRecord } from 'dns';
import { Envelope3D } from '../quadtree/envelop3D';
import { SIGTERM } from 'constants';
import { URL } from 'url';
import  mime=require("mime");
import path=require('path')
import {ConvertToGLB} from './gltfExporter';
import * as glb2b3dm from '../b3dm/glbToB3dm';

var ComponentDatatype = Cesium.ComponentDatatype;
var defined = Cesium.defined;
//对应于bufferView中的target
var WebGLConstants = Cesium.WebGLConstants;

//关于accessorType的定义
type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
//关于accessor的Component定义
const enum ComponentType { BYTE = 5120, UNSIGNED_BYTE = 5121, SHORT = 5122, UNSIGNED_SHORT = 5123, FLOAT = 5126 }

function getComponentCount(type: AccessorType) {
    switch (type) {
        case 'SCALAR':
            return 1;
        case 'VEC2':
            return 2;
        case 'VEC3':
            return 3;
        case 'VEC4':
        case 'MAT2':
            return 4;
        case 'MAT3':
            return 9;
        case 'MAT4':
            return 16;
        default:
            throw `Unknown accessor type: ${type}`;
    }
}

function getComponentSize(type: ComponentType) {
    let componentSize = 0;
    switch (type) {
        case ComponentType.BYTE:
            componentSize = 1;break;
        case ComponentType.UNSIGNED_BYTE:
            componentSize = 1;break;
        case ComponentType.SHORT:
            componentSize = 2;break;
        case ComponentType.UNSIGNED_SHORT:
            componentSize = 2;break;
        case ComponentType.FLOAT:
            componentSize = 4;break;
        default:
            throw `Unknown accessor type: ${type}`;
    }
    return componentSize;
}


const  _defaultMaterial:any=  {
    "pbrMetallicRoughness": {
        "baseColorFactor": [
            1.0,
            1.0,
            1.0,
            1.0
        ],
        "metallicFactor": 0.0
    },
    "emissiveFactor": [
        0.0,
        0.0,
        0.0
    ],
    "name": "_1_-_Default"
}


export class gltfContainerEx{
     private _gltf:any={};
     //当前容器中记录顶点，位置，法线和贴图的四个Arraybuffer（可变类型）
     private  _buffer:any={};
     //解析出对应于gltf中的buffer，可能多个,默认只有一个
     private _buffers:Array<Buffer>=[];
   //gltf对应的文件名称或者目录，编译查找额外引用的资源
     private _fileName:string;
    


     public get FileName():string{
         return this._fileName;
     }

     //返回当前容器中的gltf文件
    public get Gltf(): any {
        return this._gltf;
    }

    public get Buffers():Array<Buffer>
    {
        return this._buffers;
    }

    //获取Node的最小外接矩形，通过primitives计算。
    public GetEnvelop3D(node: any): Envelope3D | null {
        try {
            let meshId = node.mesh;
            let primitives = this.Gltf.meshes[meshId].primitives;
            let maxEnv: Envelope3D | null = null;
            primitives.forEach(element => {
                let accessorId = element.attributes.POSITION;
                let accessor = this.Gltf.accessors[accessorId];
                //处理好的坐标可能并不是世界坐标系的顺序，因此这里可能需要额外指定。
                //xy正反并不重要，关键是z一定要指定好
                let env = new Envelope3D(accessor.min[0], accessor.max[0], accessor.min[1], accessor.max[1], accessor.min[2], accessor.max[2]);
                //不断扩大最小外包矩形
                if (!maxEnv) maxEnv = env;
                else maxEnv.ExpandToInclude(env);
            });
            return  maxEnv;
        } catch (error) {
            console.log(error);
            return null;
        }
    }

    //返回场景中所有的Nodes
    public get Nodes():Array<any>
    {
        //查看sence中指定的Node，查看此Node是否有children，否则返回场景中列举的所有节点，未做迭代
        let nodes:Array<any>=[];
        let scene=this._gltf.scenes[this._gltf.scene];
        scene.nodes.forEach(element => {
            let node=this._gltf.nodes[element];
            //暂未迭代处理
            if(node.children){ 
               node.children.forEach(ele=>nodes.push(this._gltf.nodes[ele])); 
            }else{
                nodes.push(node);
            }
        });
        return  nodes;
    }

    ///获取此文件的最大范围，以便构建四叉树
    public get MaxExtent():Envelope3D|null
    {
        let nodes=this.Nodes;
        let maxExtent:Envelope3D|null=null;
        if(nodes)
        {
            nodes.forEach(node=>{
               let env= this.GetEnvelop3D(node);
               if(!maxExtent) maxExtent=env;
               else env?maxExtent.ExpandToInclude(env):null;
            });
        }
        return  maxExtent;
    }


    

    //保存为gltf文件
    public  SaveAs(filePath: string, options: gltfWriterOptions = {
        embedImage: false, defaultMaterial:false     
    }): void {   
         //默认在有images的情况下添加一个sampler
         if (this._gltf.images.length > 0) {
            this._gltf.samplers.push({
                magFilter : WebGLConstants.LINEAR,
                minFilter : WebGLConstants.NEAREST_MIPMAP_LINEAR,
                wrapS : WebGLConstants.REPEAT,
                wrapT : WebGLConstants.REPEAT
            });
        }
        //首先合并顶点等的buffer
        this.mergeBufferToNewBuffer()
        //修正bufferView的参数
       
        this._gltf.bufferViews[1].byteOffset=0;
        this._gltf.bufferViews[1].byteLength=this._buffer.positionsAndNormals.length;

        this._gltf.bufferViews[2].byteOffset = this._gltf.bufferViews[1].byteOffset + this._gltf.bufferViews[1].byteLength;
        this._gltf.bufferViews[2].byteLength = this._buffer.uvs.length;

        this._gltf.bufferViews[0].byteOffset=this._gltf.bufferViews[2].byteOffset + this._gltf.bufferViews[2].byteLength;;
        this._gltf.bufferViews[0].byteLength=this._buffer.vertexs.length;
        //将buffer转换成字符串保存在json文件中
        var source = this._buffers[0];
        // Buffers larger than ~192MB cannot be base64 encoded due to a NodeJS limitation. Source: https://github.com/nodejs/node/issues/4266
        if (source.length > 201326580) {
            console.log('Buffer is too large to embed in the glTF. Use the --separate flag instead.');
        }
        this._gltf.buffers[0]={};
        this._gltf.buffers[0].byteLength = source.byteLength;
        this._gltf.buffers[0].uri = 'data:application/octet-stream;base64,' + source.toString('base64');
          

        //当设置为默认材质时，修改所有的材质系统为默认材质，为了保证不影响到原始的gltf这里需要copy一个gltf进行操作
        let newgltf=_.cloneDeep(this._gltf);
        if(options.defaultMaterial){
            newgltf.materials=[_defaultMaterial];
            newgltf.textures=[];
            newgltf.images=[];
            newgltf.meshes.forEach(mesh=>{
                mesh.primitives.forEach(pri=>{
                    pri.material=0;
                })
            })
        }

        //根据扩展名判断需要保存的路径
        let ext= path.extname(filePath);
        if (ext == ".gltf") {
            if (options.embedImage) {
                newgltf.images.forEach(img => { this.embedImage(img, filePath); });
            }
            fs.writeJsonSync(filePath, newgltf);
        }
        else if (ext == ".glb") {
            //获取 
            let bufferGlb = ConvertToGLB(newgltf, filePath);
            fs.outputFileSync(filePath, bufferGlb, 'binary');

        } else if (ext == ".b3dm") {
            let dir = path.resolve(filePath, "..");
            let bufferGlb = ConvertToGLB(newgltf, filePath);
            var featureTableJson = {
                BATCH_LENGTH: 0
            };
            fs.outputFile(filePath, glb2b3dm(bufferGlb, featureTableJson));

        } else {
            console.log("err file extension,cant saveAs!");
        }
    }

    private embedImage(image: any, filePath: string) {
        //判断是不是datauri,如果是便不处理
        let uri = image.uri;
        if (uri && !this.isDataUrl(uri)) {
            //读取对应的图片文件 
            let preMix: string = "data:{0};base64,";
            //通过后缀获取图像的mime类型，暂只支持jpg和png两种格式
            image.mimeType = mime.getType(uri);
            if (!image.mimeType || (image.mimeType != "image/jpg" && image.mimeType != "image/png")) console.log("此uri格式的图像不被支持：" + uri);
            else {
                let dir=path.resolve(filePath,"..")
                let file = fs.readFileSync(dir + "\\" + uri);
                image.uri = preMix.replace("{0}", image.mimeType) +file.toString('base64');
            }
        }
    }


    //如果没有便初始化一个新的——gltf
    public constructor(gltf?: any,filename?:string) {
        filename?this._fileName=filename:console.log("没有设置文件路径！");
        if (gltf) {
            this._gltf = gltf;
            this.initBuffer();
        }
        else {
            //初始化一个新的gltf
            let newgltf: any = {};
            //创建asset
            newgltf.asset = {
                "generator": "pongTileGenerator",
                "version": "2.0"
            };

            //创建单个Scene节点
            newgltf.scene = 0;
            newgltf.scenes = [
                {
                    "nodes": [
                        
                    ]
                }
            ]
            //创建nodes
            newgltf.nodes = [];
            //创建Mesh
            newgltf.meshes = [];
            //创建accessor
            newgltf.accessors = [];
            //创建材质
            newgltf.materials = [];
            //创建纹理
            newgltf.textures = [];
            //创建图形
            newgltf.images = [];
            //创建采样器
            newgltf.samplers = [];
            //创建创建bufferViews
            newgltf.bufferViews = [];
            //创建三个BufferView，分别存储顶点，位置和法线，uvs
            //offset在添加Node的之后统一制定
            newgltf.bufferViews = [{
                "buffer": 0,
                "byteOffset": 208896,
                "byteLength": 21312,
                "target": 34963
            },
            {
                "buffer": 0,
                "byteOffset": 0,
                "byteLength": 156672,
                "byteStride": 12,
                "target": 34962
            },
            {
                "buffer": 0,
                "byteOffset": 156672,
                "byteLength": 52224,
                "byteStride": 8,
                "target": 34962
            }]

            //创建buffer
            newgltf.buffers = [];

            //记录顶点buffer的字节长度和各个子buffer
            this._buffer.vertexs = {length:0,buffers:[]}
            //顶点位置，position
            this._buffer.positionsAndNormals = {length:0,buffers:[]}
            //顶点法线
           // this._buffer.normals =
            //纹理坐标
            this._buffer.uvs =  {length:0,buffers:[]}
            //this._buffer.accessorId=0;
            this._gltf = newgltf;
        }
        
    }

    private initBuffer() {
        this._buffers = this._gltf.buffers.map(buf => {
            if (this.isDataUrl(buf.uri)) {
                console.log("a buffer is  datauri!so read it!")
                return dataUriToBuffer(buf.uri);
            }
            else {
                let bufferPath = path.resolve(this._fileName, "../"+buf.uri)
                return fs.readFileSync(bufferPath);
            }
        });
    }

    //判断uri是否是datauri
    private isDataUrl(uri:string)
    {
        if (!defined(uri)) {
            return false;
        }
        //Return true if the uri is a data uri
        return /^data\:/i.test(uri);
    }



    //通过文件读取
    public static readGltfByNode(filePath: string): gltfContainerEx | null  {
        let exit = fs.pathExistsSync(filePath);
        if (exit) {
            let gltf = fs.readJsonSync(filePath);
            let newContainer = new gltfContainerEx(gltf,filePath);
            return newContainer;
        }
        return null;
    }



    //通过已加载的Gltf添加一个新的节点
    //重载方法即添加一个已有的数据实体
    public  AddNode(node:any,gltf:gltfContainerEx|null):void{
        //创建一个ArrayBuffer，这将作为buffer的载体
        if(!node||!gltf) return;
        //获取Node中的mesh
        //读取gltf中的buffer，有几个读几个
        let meshId=node.mesh;
        //根据mesh获取primitives
        let primitives=gltf.Gltf.meshes[meshId].primitives;
        //从primitive中获取其顶点坐标信息
        
        //在node中添加Id信息
        let newNode:any={mesh:this._gltf.meshes.length};
        //如果有名称便添加名称
        node.name?newNode.name=node.name:null;
        //添加一个节点
        this._gltf.nodes.push(newNode);
        //同时添加一个mesh,目前的关系是一个Node对应一个Mesh
        let newMesh={primitives:[]};
        this._gltf.meshes.push(newMesh);

        this.AddMesh(gltf.Gltf.meshes[meshId],gltf);
        //在scene中添加新的节点
        this._gltf.scenes[0].nodes.push(this._gltf.scenes[0].nodes.length);
    }

    public AddMesh(mesh: any, gltf: gltfContainerEx): void {

        let pris = mesh.primitives;
        let meshName = mesh.name;
        if (!defined(meshName) || !pris) { console.log("Node中的mesh没有primitives或者没有mesh名称，无法添加！"); return; }

        pris.forEach(pri => {
            //根据当前的情况，创建一个新的pri对象
            let newprj = _.cloneDeep(pri);
            //在当前最新的一个Mesh中添加primitive信息
            let lastMesh: any = _.last(this._gltf.meshes);
            lastMesh ? lastMesh.primitives.push(newprj) : null;
            //读取其中的顶点的accessor
            let hasIndices = pri.indices >= 0;
            //额外处理顶点索引的问题。
            if (hasIndices) {
                //获取buffer
                let indicesId = pri.indices;
                //添加accessor
                let indicesArrayBuffer: Buffer = gltf.GetArraybufferByAccessorId(indicesId);
                //创建一个新的accrssor
                let newAccessorIndices = _.cloneDeep(gltf.Gltf.accessors[indicesId]);
                newAccessorIndices.bufferView = 0;
                newAccessorIndices.byteOffset = this._buffer.vertexs.length;

                this._gltf.accessors.push(newAccessorIndices);
                newprj.indices = this._gltf.accessors.length - 1;
                //添加buffer
                this._buffer.vertexs.buffers.push(indicesArrayBuffer);
                this._buffer.vertexs.length = this._buffer.vertexs.length + indicesArrayBuffer.byteLength;
            }

            

            let hasNormal = pri.attributes && pri.attributes.NORMAL
            if (hasNormal) {

                let normalsId = pri.attributes.NORMAL;
                let normalsArrayBuffer = gltf.GetArraybufferByAccessorId(normalsId);
                let newAccessorNormal = _.cloneDeep(gltf.Gltf.accessors[normalsId]);
                newAccessorNormal.bufferView = 1;
                newAccessorNormal.byteOffset = this._buffer.positionsAndNormals.length;

                this._gltf.accessors.push(newAccessorNormal);
                newprj.attributes.NORMAL = this._gltf.accessors.length - 1;

                this._buffer.positionsAndNormals.buffers.push(normalsArrayBuffer);
                this._buffer.positionsAndNormals.length = this._buffer.positionsAndNormals.length + normalsArrayBuffer.byteLength;
            }

            //获取顶点的arraybuffer
            let hasposition = pri.attributes && pri.attributes.POSITION >= 0;
            if (hasposition) {

                let positionsId = pri.attributes.POSITION
                let positionsArrayBuffer = gltf.GetArraybufferByAccessorId(positionsId);
                //先添加Accessor，再添加实际的buffer
                let newAccessorPos = _.cloneDeep(gltf.Gltf.accessors[positionsId]);
                newAccessorPos.bufferView = 1;
                //记录其偏移
                newAccessorPos.byteOffset = this._buffer.positionsAndNormals.length;

                this._gltf.accessors.push(newAccessorPos);
                newprj.attributes.POSITION = this._gltf.accessors.length - 1;

                //添加buffer
                this._buffer.positionsAndNormals.buffers.push(positionsArrayBuffer);
                this._buffer.positionsAndNormals.length = this._buffer.positionsAndNormals.length + positionsArrayBuffer.byteLength;
            }

            let hasuvs = pri.attributes && pri.attributes.TEXCOORD_0;
            if (hasuvs) {

                let uvsId = pri.attributes.TEXCOORD_0;
                let uvsArrayBuffer = gltf.GetArraybufferByAccessorId(uvsId);

                let newAccessoruvs = _.cloneDeep(gltf.Gltf.accessors[uvsId]);
                newAccessoruvs.bufferView = 2;
                newAccessoruvs.byteOffset = this._buffer.uvs.length;
                this._gltf.accessors.push(newAccessoruvs);
                newprj.attributes.TEXCOORD_0 = this._gltf.accessors.length - 1;

                this._buffer.uvs.buffers.push(uvsArrayBuffer);
                this._buffer.uvs.length = this._buffer.uvs.length + uvsArrayBuffer.byteLength;
            }

            //获取材质信息,考虑可能的共用性,材质数量和纹理数量不相同，但是images和sampler以及texture有共用的情况。
            let materialsId = pri.material;
            let material = gltf.Gltf.materials[materialsId];
            //
            //获取其中引用的纹理Id,三种纹理的
            let textureId1 = material.pbrMetallicRoughness && material.pbrMetallicRoughness.baseColorTexture ? material.pbrMetallicRoughness.baseColorTexture.index : -1;
            let textureId2 = material.emissiveTexture ? material.emissiveTexture.index : -1;
            let textureId3 = material.occlusionTexture ? material.occlusionTexture.index : -1;
            
            let newmaterial = _.cloneDeep(material);
            if (textureId1 != -1) {
                //获取此纹理
                let texture = gltf.Gltf.textures[textureId1];
                //如果源纹理没有名称，给予源纹理一个名称,均是通过此
                texture.name = texture.name ? texture.name : meshName + "_" + textureId1.toString()
                //查找此纹理是否已经保存，如果是便使用保存的纹理，否便创建新的纹理，使用纹理名称作为标识。（无名称使用Id号）
                let newTextureId = this.AddOrGetTextureId(texture, gltf);
                //材质中的三种坐标均相同，暂不详究
                newmaterial.pbrMetallicRoughness.baseColorTexture.index = newTextureId;
            }
            if (textureId2 != -1) {
                let texture = gltf.Gltf.textures[textureId1];
                //如果源纹理没有名称，给予源纹理一个名称,均是通过此
                texture.name = texture.name ? texture.name : meshName + "_" + textureId1.toString()
                //查找此纹理是否已经保存，如果是便使用保存的纹理，否便创建新的纹理，使用纹理名称作为标识。（无名称使用Id号）
                let newTextureId = this.AddOrGetTextureId(texture, gltf);
                //材质中的三种坐标均相同，暂不详究
                newmaterial.emissiveTexture ? newmaterial.emissiveTexture.index = newTextureId : null;
            }
            if (textureId3 != -1) {
                let texture = gltf.Gltf.textures[textureId1];
                //如果源纹理没有名称，给予源纹理一个名称,均是通过此
                texture.name = texture.name ? texture.name : meshName + "_" + textureId1.toString()
                //查找此纹理是否已经保存，如果是便使用保存的纹理，否便创建新的纹理，使用纹理名称作为标识。（无名称使用Id号）
                let newTextureId = this.AddOrGetTextureId(texture, gltf);
                //材质中的三种坐标均相同，暂不详究
                newmaterial.occlusionTexture ? newmaterial.occlusionTexture.index = newTextureId : null;
            }
            //添加材质库,材质库数量和primitive相同，因此不需要判断重复性
            this._gltf.materials.push(newmaterial);
            //在prj中添加材质Id，否则不添加
            newprj.material = this._gltf.materials.length - 1;
        });
    }

    private AddOrGetTextureId(originalTexture: any,gltf:gltfContainerEx):any {
        let textures: Array<any> = this._gltf.textures;
        let index = textures.findIndex(ele => { return ele == originalTexture.name; });
        if (index == -1) {
            let newTexture = { sampler: 0, source: -1, name: originalTexture.name };
            //查找相应Image并添加
            let image=gltf.Gltf.images[originalTexture.source];
            //由于不同的texture也可能共用一个Image,因此需要查找图片uri是否相同，相同便不必添加直接返回imgId
            let imgIndex=this._gltf.images.findIndex(ele=>{return  ele.uri===image.uri;});     
            if(imgIndex==-1)
            {
                let img=_.cloneDeep(image);
                this._gltf.images.push(img);
                newTexture.source=this._gltf.images.length-1;
            }else
            {
                newTexture.source=imgIndex;
            }
            textures.push(newTexture);
            return  textures.length-1;
        };
        return index;
    }


    ///将多个buffer按照 顶点，（位置+法线),纹理坐标的顺序合并成新的buffer
    private mergeBufferToNewBuffer()
    {   
        //按顺序合并成数组
        let bufferArray:Array<Buffer>=this._buffer.positionsAndNormals.buffers.concat(this._buffer.uvs.buffers,this._buffer.vertexs.buffers);  
        let buffer:Buffer=Buffer.concat(bufferArray);
        this._buffers.push(buffer);      
    }

    private GetArraybufferByAccessorId(accessorId:number):Buffer {
        //获取其Arraybuffer内容
        let accessor = this._gltf.accessors[accessorId];
        let bufferViewId = accessor.bufferView;
        let bufferView = this._gltf.bufferViews[bufferViewId];
        let bufferId = bufferView.buffer;
        //获取真实的arraybuffer的dataView
        let startIndex = bufferView.byteOffset + accessor.byteOffset;
        let length = getComponentCount(accessor.type) * getComponentSize(accessor.componentType)*accessor.count;
        //截取了其中顶点内容，并添加到buffer中
        let indicesArraybuffer = this._buffers[bufferId].slice(startIndex, startIndex + length)
        return indicesArraybuffer;
    }

     
}


//gltf写接口的参数
export interface gltfWriterOptions
{
    //嵌入图像到gltf文件中,仅针对输出为gltf有效
     embedImage?:boolean;
     defaultMaterial?:boolean
}


export class gltfContainerExTest
{
    public static Test()
    {
        //E:\swyy\TestFolder\objTo3d-tiles\test\buildings\output\images
        //let curpath="E:\\swyy\\TestFolder\\objTo3d-tiles\\test\\output\\singlebuilding.gltf";
        //let outputPath="E:\\swyy\\TestFolder\\objTo3d-tiles\\test\\output\\onebuildings.gltf"
        let curpath="E:\\swyy\\TestFolder\\objTo3d-tiles\\test\\buildings\\output\\images\\buildings.gltf";
        let outputPath="E:\\swyy\\TestFolder\\objTo3d-tiles\\test\\buildings\\output\\images\\onebuildings.gltf"
        let newContainer=new gltfContainerEx();
        let container= gltfContainerEx.readGltfByNode(curpath);
        //container?container.Gltf.nodes.forEach(node=> newContainer.AddNode(node,container)):null;
        container?newContainer.AddNode(container.Gltf.nodes[2],container):null;
        container?newContainer.AddNode(container.Gltf.nodes[3],container):null;
        container?newContainer.AddNode(container.Gltf.nodes[4],container):null;
        newContainer.SaveAs(outputPath);
    }
}





