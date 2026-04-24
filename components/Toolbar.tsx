/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import { Moon, PanelRight, Pause, Play, Radio, RotateCcw, Sun } from 'lucide-react';

interface ToolbarProps {
  isPaused: boolean;
  togglePause: () => void;
  onReset: () => void;
  showSidebar: boolean;
  toggleSidebar: () => void;
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  onReloadFromStream?: () => void;
  streamConnected?: boolean;
  hasStreamScene?: boolean;
}

/**
 * Toolbar
 * Floating control bar for simulation actions.
 */
export function Toolbar({
  isPaused,
  togglePause,
  onReset,
  showSidebar,
  toggleSidebar,
  isDarkMode,
  toggleDarkMode,
  onReloadFromStream,
  streamConnected,
  hasStreamScene,
}: ToolbarProps) {
  const panelStyle = isDarkMode ? "bg-slate-900/80 border-white/10 text-slate-100" : "bg-white/70 border-white/80 text-slate-800";
  const iconFill = isDarkMode ? "fill-slate-100" : "fill-slate-800";

  return (
    <div className="absolute bottom-10 left-1/2 -translate-x-1/2 min-[660px]:left-10 min-[660px]:translate-x-0 flex items-center gap-4 z-30">
      
      {/* Play/Pause Button */}
      <button 
        onClick={togglePause} 
        className={`w-14 h-14 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${panelStyle}`}
        title={isPaused ? "Resume" : "Pause"}
      >
        {isPaused ? <Play className={`w-6 h-6 ${iconFill}`} /> : <Pause className={`w-6 h-6 ${iconFill}`} />}
      </button>
      
      {/* Reset Button */}
      <button 
        onClick={onReset} 
        className={`w-14 h-14 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${panelStyle}`}
        title="Reset Simulation"
      >
        <RotateCcw className="w-6 h-6" />
      </button>

      {/* Boxer3D Stream — reload sim with latest SceneReport */}
      {onReloadFromStream && (
        <button
          onClick={onReloadFromStream}
          disabled={!hasStreamScene}
          className={`relative w-14 h-14 rounded-2xl glass-panel flex items-center justify-center transition-all shadow-xl ${hasStreamScene ? 'hover:scale-105 active:scale-95' : 'opacity-50 cursor-not-allowed'} ${panelStyle}`}
          title={streamConnected ? (hasStreamScene ? 'Reload sim from Boxer3D SceneReport' : 'Stream connected, waiting for first frame') : 'Boxer3D stream disconnected (ws://localhost:8787)'}
        >
          <Radio className="w-6 h-6" />
          <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${streamConnected ? 'bg-emerald-500' : 'bg-slate-400'}`} />
        </button>
      )}

      {/* Dark Mode Toggle */}
      <button 
        onClick={toggleDarkMode} 
        className={`w-14 h-14 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${panelStyle}`}
        title={isDarkMode ? "Light Mode" : "Dark Mode"}
      >
        {isDarkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
      </button>

      {/* Sidebar Toggle */}
      <button 
        onClick={toggleSidebar} 
        className={`w-14 h-14 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${showSidebar ? (isDarkMode ? 'text-indigo-400 bg-slate-800' : 'text-indigo-600 bg-white') : panelStyle}`}
        title="Toggle Analysis Panel"
      >
        <PanelRight className="w-6 h-6" />
      </button>
    </div>
  );
}
