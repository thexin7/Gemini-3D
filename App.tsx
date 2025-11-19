
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import React, { useEffect, useRef, useState } from 'react';
import { VoxelEngine } from './services/VoxelEngine';
import { UIOverlay } from './components/UIOverlay';
import { JsonModal } from './components/JsonModal';
import { PromptModal } from './components/PromptModal';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Generators } from './utils/voxelGenerators';
import { AppState, VoxelData, SavedModel } from './types';
import { GoogleGenAI, Type } from "@google/genai";

/**
 * 主应用程序组件 (App Component)
 * ---------------------------
 * 核心职责：
 * 1. **连接层**：连接 React 的声明式 UI 和 Three.js 的命令式 3D 引擎。
 * 2. **状态机**：管理整个应用的生命周期（静止 -> 拆解 -> 重组）。
 * 3. **AI 桥梁**：负责与 Google Gemini API 通信，将自然语言转换为 3D 坐标数据。
 */
const App: React.FC = () => {
  // 引用 DOM 容器，Three.js 的 Canvas 将被挂载到这个 div 下
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 保持对 3D 引擎实例的引用，以便直接调用其方法 (如 .dismantle(), .rebuild())
  // 使用 useRef 而不是 useState，因为 3D 引擎是可变对象，不需要触发 React 重新渲染
  const engineRef = useRef<VoxelEngine | null>(null);
  
  // 应用程序状态机：控制 UI 显示什么按钮，以及允许什么操作
  const [appState, setAppState] = useState<AppState>(AppState.STABLE);
  const [voxelCount, setVoxelCount] = useState<number>(0);
  
  // --- UI 模态框状态管理 ---
  const [isJsonModalOpen, setIsJsonModalOpen] = useState(false);
  const [jsonModalMode, setJsonModalMode] = useState<'view' | 'import'>('view');
  
  const [isPromptModalOpen, setIsPromptModalOpen] = useState(false);
  const [promptMode, setPromptMode] = useState<'create' | 'morph'>('create');
  
  const [showWelcome, setShowWelcome] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  
  const [jsonData, setJsonData] = useState('');
  const [isAutoRotate, setIsAutoRotate] = useState(true);

  // --- 模型数据管理 ---
  // currentBaseModel: 当前场景主要展示的是什么（例如 "Eagle" 或用户生成的 "Castle"）
  // customBuilds: 用户通过 AI 新建的模型历史记录
  // customRebuilds: 用户通过 AI 对某个特定模型进行重组的方案历史
  const [currentBaseModel, setCurrentBaseModel] = useState<string>('Eagle');
  const [customBuilds, setCustomBuilds] = useState<SavedModel[]>([]);
  const [customRebuilds, setCustomRebuilds] = useState<SavedModel[]>([]);

  /**
   * 初始化 3D 引擎
   * 原理：React 组件挂载后 (useEffect)，实例化非 React 的 VoxelEngine 类。
   * 并设置回调函数，允许 Engine 在状态变化时通知 React 更新 UI。
   */
  useEffect(() => {
    if (!containerRef.current) return;

    // 实例化引擎，传入 DOM 节点和状态回调
    const engine = new VoxelEngine(
      containerRef.current,
      (newState) => setAppState(newState), // 当物理状态改变（如方块停止移动）时更新 React
      (count) => setVoxelCount(count)      // 当方块数量改变时更新 React
    );

    engineRef.current = engine;

    // 加载默认的初始模型 (老鹰)
    engine.loadInitialModel(Generators.Eagle());

    // 响应式布局：处理窗口大小调整
    const handleResize = () => engine.handleResize();
    window.addEventListener('resize', handleResize);

    // 5秒后自动淡出欢迎屏幕，提升体验
    const timer = setTimeout(() => setShowWelcome(false), 5000);

    // 清理函数：组件卸载时销毁 Three.js 实例，防止内存泄漏（WebGL Context Loss）
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timer);
      engine.cleanup();
    };
  }, []);

  // --- 交互逻辑 ---

  // 触发拆解物理模拟
  const handleDismantle = () => {
    engineRef.current?.dismantle();
  };

  // 加载硬编码的预设场景 (重置所有方块位置)
  const handleNewScene = (type: 'Eagle') => {
    const generator = Generators[type];
    if (generator && engineRef.current) {
      engineRef.current.loadInitialModel(generator());
      setCurrentBaseModel('Eagle');
    }
  };

  // 切换到用户生成的自定义模型 (Create 模式产物)
  const handleSelectCustomBuild = (model: SavedModel) => {
      if (engineRef.current) {
          engineRef.current.loadInitialModel(model.data);
          setCurrentBaseModel(model.name);
      }
  };

  // 触发预设的重组动画 (Morph 模式：如把老鹰变成猫)
  const handleRebuild = (type: 'Eagle' | 'Cat' | 'Rabbit' | 'Twins') => {
    const generator = Generators[type];
    if (generator && engineRef.current) {
      engineRef.current.rebuild(generator());
    }
  };

  // 触发用户自定义的重组动画
  const handleSelectCustomRebuild = (model: SavedModel) => {
      if (engineRef.current) {
          engineRef.current.rebuild(model.data);
      }
  };

  // 导出当前模型为 JSON
  const handleShowJson = () => {
    if (engineRef.current) {
      setJsonData(engineRef.current.getJsonData());
      setJsonModalMode('view');
      setIsJsonModalOpen(true);
    }
  };

  const handleImportClick = () => {
      setJsonModalMode('import');
      setIsJsonModalOpen(true);
  };

  // 导入 JSON 并解析为模型
  const handleJsonImport = (jsonStr: string) => {
      try {
          const rawData = JSON.parse(jsonStr);
          if (!Array.isArray(rawData)) throw new Error("JSON must be an array");

          // 数据清洗与标准化
          const voxelData: VoxelData[] = rawData.map((v: any) => {
              // 兼容十六进制字符串 (#FFFFFF) 和 十进制数字 (16777215) 两种颜色格式
              let colorVal = v.c || v.color;
              let colorInt = 0xCCCCCC;

              if (typeof colorVal === 'string') {
                  if (colorVal.startsWith('#')) colorVal = colorVal.substring(1);
                  colorInt = parseInt(colorVal, 16);
              } else if (typeof colorVal === 'number') {
                  colorInt = colorVal;
              }

              return {
                  x: Number(v.x) || 0,
                  y: Number(v.y) || 0,
                  z: Number(v.z) || 0,
                  color: isNaN(colorInt) ? 0xCCCCCC : colorInt
              };
          });
          
          if (engineRef.current) {
              engineRef.current.loadInitialModel(voxelData);
              setCurrentBaseModel('Imported Build');
          }
      } catch (e) {
          console.error("Failed to import JSON", e);
          alert("Failed to import JSON. Please ensure the format is correct.");
      }
  };

  const openPrompt = (mode: 'create' | 'morph') => {
      setPromptMode(mode);
      setIsPromptModalOpen(true);
  }
  
  const handleToggleRotation = () => {
      const newState = !isAutoRotate;
      setIsAutoRotate(newState);
      if (engineRef.current) {
          engineRef.current.setAutoRotate(newState);
      }
  }

  /**
   * 核心原理：AI 生成逻辑
   * -------------------
   * 1. **Prompt Engineering (提示词工程)**：
   *    我们不直接问 AI "画一只猫"，而是给它设定一个非常具体的"体素架构师"角色。
   *    如果是 "Rebuild" (重组) 模式，我们会把当前场景中已有的颜色列表提取出来传给 AI，
   *    要求 AI "尽量使用现有颜色"，从而在视觉上创造出"同一个物体变形"的错觉。
   * 
   * 2. **Structured Output (结构化输出)**：
   *    使用 `responseSchema` 强制 AI 返回严格的 JSON 数组格式 [{x,y,z,color}, ...]。
   *    这避免了传统 LLM 可能返回的 Markdown 格式或多余的解释性文字，确保数据可直接被代码解析。
   */
  const handlePromptSubmit = async (prompt: string) => {
    if (!process.env.API_KEY) {
        throw new Error("API Key not found");
    }

    setIsGenerating(true);
    setIsPromptModalOpen(false); // 关闭输入框，展示加载状态

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        // 使用 Gemini 3 Pro，因为它具有更强的空间推理逻辑，能生成结构更合理的 3D 物体
        const model = 'gemini-3-pro-preview';
        
        let systemContext = "";
        
        // --- 策略分支 ---
        if (promptMode === 'morph' && engineRef.current) {
            // 策略 A: 变形 (Rebuild)
            // 提取当前场景的所有颜色，作为"调色板"限制 AI
            const availableColors = engineRef.current.getUniqueColors().join(', ');
            systemContext = `
                CONTEXT: You are re-assembling an existing pile of lego-like voxels.
                The current pile consists of these colors: [${availableColors}].
                TRY TO USE THESE COLORS if they fit the requested shape.
                If the requested shape absolutely requires different colors, you may use them, but prefer the existing palette to create a "rebuilding" effect.
                The model should be roughly the same volume as the previous one.
            `;
        } else {
            // 策略 B: 新建 (Create)
            // 允许 AI 自由发挥，使用任何它认为合适的颜色
            systemContext = `
                CONTEXT: You are creating a brand new voxel art scene from scratch.
                Be creative with colors.
            `;
        }

        // 调用 API
        const response = await ai.models.generateContent({
            model,
            contents: `
                    ${systemContext}
                    
                    Task: Generate a 3D voxel art model of: "${prompt}".
                    
                    Strict Rules:
                    1. Use approximately 150 to 600 voxels.
                    2. The model must be centered at x=0, z=0.
                    3. The bottom of the model must be at y=0 or slightly higher.
                    4. Ensure the structure is physically plausible (connected).
                    5. Coordinates should be integers.
                    
                    Return ONLY a JSON array of objects.`,
            config: {
                responseMimeType: "application/json",
                // 定义 JSON Schema，让 Gemini 知道我们严格需要的数据结构
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            x: { type: Type.INTEGER },
                            y: { type: Type.INTEGER },
                            z: { type: Type.INTEGER },
                            color: { type: Type.STRING, description: "Hex color code e.g. #FF5500" }
                        },
                        required: ["x", "y", "z", "color"]
                    }
                }
            }
        });

        if (response.text) {
            const rawData = JSON.parse(response.text);
            
            // 将 API 数据转换为应用内部格式
            const voxelData: VoxelData[] = rawData.map((v: any) => {
                let colorStr = v.color;
                if (colorStr.startsWith('#')) colorStr = colorStr.substring(1);
                const colorInt = parseInt(colorStr, 16);
                
                return {
                    x: v.x,
                    y: v.y,
                    z: v.z,
                    color: isNaN(colorInt) ? 0xCCCCCC : colorInt
                };
            });

            if (engineRef.current) {
                if (promptMode === 'create') {
                    // 这是一个新模型，直接加载
                    engineRef.current.loadInitialModel(voxelData);
                    setCustomBuilds(prev => [...prev, { name: prompt, data: voxelData }]);
                    setCurrentBaseModel(prompt);
                } else {
                    // 这是一个变形请求，执行重组动画
                    engineRef.current.rebuild(voxelData);
                    // 记录这个重组是基于哪个模型产生的，以便在 UI 上正确分类显示
                    setCustomRebuilds(prev => [...prev, { 
                        name: prompt, 
                        data: voxelData,
                        baseModel: currentBaseModel 
                    }]);
                }
            }
        }
    } catch (err) {
        console.error("Generation failed", err);
        alert("Oops! Something went wrong generating the model.");
    } finally {
        setIsGenerating(false);
    }
  };

  // 根据当前模型，筛选出相关的重组选项
  const relevantRebuilds = customRebuilds.filter(
      r => r.baseModel === currentBaseModel
  );

  return (
    <div className="relative w-full h-screen bg-[#f0f2f5] overflow-hidden">
      {/* 3D 渲染层 (底座) */}
      <div ref={containerRef} className="absolute inset-0 z-0" />
      
      {/* UI 交互层 (悬浮) */}
      <UIOverlay 
        voxelCount={voxelCount}
        appState={appState}
        currentBaseModel={currentBaseModel}
        customBuilds={customBuilds}
        customRebuilds={relevantRebuilds} 
        isAutoRotate={isAutoRotate}
        isInfoVisible={showWelcome}
        isGenerating={isGenerating}
        onDismantle={handleDismantle}
        onRebuild={handleRebuild}
        onNewScene={handleNewScene}
        onSelectCustomBuild={handleSelectCustomBuild}
        onSelectCustomRebuild={handleSelectCustomRebuild}
        onPromptCreate={() => openPrompt('create')}
        onPromptMorph={() => openPrompt('morph')}
        onShowJson={handleShowJson}
        onImportJson={handleImportClick}
        onToggleRotation={handleToggleRotation}
        onToggleInfo={() => setShowWelcome(!showWelcome)}
      />

      {/* 全局模态框组件 */}
      <WelcomeScreen visible={showWelcome} />

      <JsonModal 
        isOpen={isJsonModalOpen}
        onClose={() => setIsJsonModalOpen(false)}
        data={jsonData}
        isImport={jsonModalMode === 'import'}
        onImport={handleJsonImport}
      />

      <PromptModal
        isOpen={isPromptModalOpen}
        mode={promptMode}
        onClose={() => setIsPromptModalOpen(false)}
        onSubmit={handlePromptSubmit}
      />
    </div>
  );
};

export default App;
