/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { useAuthState } from 'react-firebase-hooks/auth';
import { useCollection } from 'react-firebase-hooks/firestore';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  serverTimestamp, 
  doc, 
  setDoc,
  limit,
  getDocs,
  getDocFromServer,
  collectionGroup,
  where,
  deleteDoc,
  updateDoc
} from 'firebase/firestore';
import { auth, db, signInWithGoogle, logout, handleFirestoreError, OperationType } from './firebase';
import { GoogleGenAI, Modality } from "@google/genai";
import { 
  Send, 
  Plus, 
  Image as ImageIcon, 
  Video as VideoIcon, 
  LogOut, 
  User, 
  Bot, 
  Loader2,
  Sparkles,
  Menu,
  X,
  History,
  Copy,
  Check,
  Edit2,
  Search,
  ExternalLink,
  Cloud,
  CloudCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const CodeBlock = ({ children, className, ...props }: { children: any, className?: string }) => {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const onCopy = () => {
    if (preRef.current) {
      navigator.clipboard.writeText(preRef.current.innerText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative group my-4 rounded-md overflow-hidden bg-zinc-900 border border-zinc-800">
      <button
        onClick={onCopy}
        className="absolute right-2 top-2 p-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-400 opacity-0 group-hover:opacity-100 transition-all hover:bg-zinc-700 hover:text-zinc-200 z-10"
      >
        {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
      </button>
      <pre ref={preRef} className={`overflow-x-auto p-4 ${className || ''}`} {...props}>
        {children}
      </pre>
    </div>
  );
};

interface ChatSession {
  id: string;
  userId: string;
  title: string;
  createdAt: any;
  updatedAt: any;
}

interface ChatMessage {
  id: string;
  chatId: string;
  userId?: string;
  role: 'user' | 'model';
  content: string;
  type: 'text' | 'image' | 'video';
  mediaUrl?: string;
  timestamp: any;
  groundingMetadata?: any;
}

const VideoPlayer = ({ src }: { src: string }) => {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchVideo = async () => {
      try {
        const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY!;
        const response = await fetch(src, {
          method: 'GET',
          headers: {
            'x-goog-api-key': apiKey,
          },
        });
        if (!response.ok) throw new Error('Failed to fetch video');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setVideoUrl(url);
      } catch (err) {
        console.error('Video fetch error:', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    if (src.startsWith('http')) {
      fetchVideo();
    } else {
      setVideoUrl(src);
      setLoading(false);
    }

    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [src]);

  if (loading) {
    return (
      <div className="w-full h-48 bg-zinc-900 flex items-center justify-center rounded-lg">
        <Loader2 className="w-6 h-6 text-emerald-500 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-48 bg-zinc-900 flex items-center justify-center rounded-lg text-zinc-500 text-xs">
        Failed to load video
      </div>
    );
  }

  return (
    <video 
      src={videoUrl || ''} 
      controls 
      className="w-full h-auto max-h-[400px]"
    />
  );
};

export default function App() {
  const [user, loading, error] = useAuthState(auth);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('chat_draft') || '';
    }
    return '';
  });
  const [selectedModel, setSelectedModel] = useState<'gemini-3.1-pro-preview' | 'gemini-3-flash-preview' | 'gemini-3.1-flash-lite-preview'>('gemini-3-flash-preview');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<'1:1' | '16:9' | '9:16'>('1:1');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [isChatSearchOpen, setIsChatSearchOpen] = useState(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<ChatMessage[]>([]);
  const [isSearchingGlobal, setIsSearchingGlobal] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editInput, setEditInput] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch user's chat sessions
  const [chatsValue] = useCollection(
    user ? query(
      collection(db, 'chats'),
      where('userId', '==', user.uid),
      orderBy('updatedAt', 'desc'),
      limit(20)
    ) : null
  );

  // Fetch messages for current chat
  const [messagesValue] = useCollection(
    currentChatId ? query(
      collection(db, `chats/${currentChatId}/messages`),
      orderBy('timestamp', 'asc')
    ) : null
  );

  const messages = (messagesValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || []) as ChatMessage[];
  const chatSessions = (chatsValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || []) as ChatSession[];

  const filteredChatSessions = chatSessions.filter(chat => 
    chat.title.toLowerCase().includes(sidebarSearchQuery.toLowerCase())
  );

  const filteredMessages = messages.filter(msg => 
    msg.content.toLowerCase().includes(chatSearchQuery.toLowerCase())
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Firestore Connection Test
  useEffect(() => {
    async function testConnection() {
      const path = 'test/connection';
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        // Only throw if the client is offline, indicating a config issue.
        // Ignore permission errors as they are expected for unauthenticated users.
        if (error instanceof Error && error.message.includes('the client is offline')) {
          handleFirestoreError(error, OperationType.GET, path);
        }
      }
    }
    testConnection();
  }, []);

  // Handle global search
  useEffect(() => {
    const searchGlobal = async () => {
      if (!user || !globalSearchQuery.trim()) {
        setGlobalSearchResults([]);
        return;
      }
      setIsSearchingGlobal(true);
      try {
        const q = query(
          collectionGroup(db, 'messages'),
          where('userId', '==', user.uid),
          orderBy('timestamp', 'desc'),
          limit(50)
        );
        const querySnapshot = await getDocs(q);
        const results = querySnapshot.docs
          .map(doc => ({ id: doc.id, ...doc.data() } as ChatMessage))
          .filter(msg => msg.content.toLowerCase().includes(globalSearchQuery.toLowerCase()));
        setGlobalSearchResults(results);
      } catch (err) {
        console.error('Global search error:', err);
      } finally {
        setIsSearchingGlobal(false);
      }
    };

    const timer = setTimeout(searchGlobal, 500);
    return () => clearTimeout(timer);
  }, [globalSearchQuery, user]);

  // Handle message edit
  const handleEditMessage = async (messageId: string, newContent: string) => {
    if (!currentChatId || !newContent.trim()) return;
    try {
      await updateDoc(doc(db, `chats/${currentChatId}/messages`, messageId), {
        content: newContent,
        updatedAt: serverTimestamp()
      });
      setEditingMessageId(null);
    } catch (err) {
      console.error('Edit error:', err);
    }
  };

  // Handle message copy
  const copyToClipboard = (text: string, messageId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMessageId(messageId);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  // Auto-save draft
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsSavingDraft(true);
      localStorage.setItem('chat_draft', input);
      const timer = setTimeout(() => setIsSavingDraft(false), 800);
      return () => clearTimeout(timer);
    }
  }, [input]);

  // Handle login
  const handleLogin = async () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') {
        console.warn('Sign-in popup closed by user');
      } else if (err.message?.includes('Pending promise was never set')) {
        // Ignore this internal Firebase error as it usually resolves itself
        console.warn('Auth internal assertion failed, retrying may be necessary');
      } else {
        console.error('Sign-in error:', err);
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  // Handle new chat
  const startNewChat = async () => {
    if (!user) return;
    const chatRef = await addDoc(collection(db, 'chats'), {
      userId: user.uid,
      title: 'New Conversation',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    setCurrentChatId(chatRef.id);
    setIsSidebarOpen(false);
  };

  // Handle sending message
  const handleSend = async (type: 'text' | 'image' | 'video' = 'text') => {
    if (!user || (!input.trim() && type === 'text')) return;
    
    let chatId = currentChatId;
    if (!chatId) {
      const chatRef = await addDoc(collection(db, 'chats'), {
        userId: user.uid,
        title: input.slice(0, 30) || 'New Conversation',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      chatId = chatRef.id;
      setCurrentChatId(chatId);
    }

    const userMessage = {
      chatId,
      userId: user.uid,
      role: 'user',
      content: input,
      type,
      timestamp: serverTimestamp(),
    };

    await addDoc(collection(db, `chats/${chatId}/messages`), userMessage);
    setInput('');
    localStorage.removeItem('chat_draft');
    setIsGenerating(true);

    const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY!;
    const ai = new GoogleGenAI({ apiKey });

    try {
      if (type === 'image') {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: { parts: [{ text: input }] },
          config: {
            imageConfig: {
              aspectRatio: aspectRatio as any,
            }
          }
        });
        
        let imageUrl = '';
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            imageUrl = `data:image/png;base64,${part.inlineData.data}`;
          }
        }

        await addDoc(collection(db, `chats/${chatId}/messages`), {
          chatId,
          userId: user.uid,
          role: 'model',
          content: 'Here is your generated image:',
          type: 'image',
          mediaUrl: imageUrl,
          timestamp: serverTimestamp(),
        });
      } else if (type === 'video') {
        // Check for API key selection for Veo models
        if (typeof window !== 'undefined' && window.aistudio) {
          const hasKey = await window.aistudio.hasSelectedApiKey();
          if (!hasKey) {
            await window.aistudio.openSelectKey();
          }
        }

        let operation = await ai.models.generateVideos({
          model: 'veo-3.1-lite-generate-preview',
          prompt: input,
          config: { 
            numberOfVideos: 1, 
            resolution: '720p', 
            aspectRatio: aspectRatio === '1:1' ? '16:9' : aspectRatio as any 
          }
        });

        while (!operation.done) {
          await new Promise(resolve => setTimeout(resolve, 10000));
          operation = await ai.operations.getVideosOperation({ operation });
        }

        const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
        await addDoc(collection(db, `chats/${chatId}/messages`), {
          chatId,
          userId: user.uid,
          role: 'model',
          content: 'Here is your generated video:',
          type: 'video',
          mediaUrl: downloadLink,
          timestamp: serverTimestamp(),
        });
      } else {
        const response = await ai.models.generateContent({
          model: selectedModel,
          contents: input,
          config: {
            tools: [{ googleSearch: {} }],
          }
        });

        await addDoc(collection(db, `chats/${chatId}/messages`), {
          chatId,
          userId: user.uid,
          role: 'model',
          content: response.text || 'Sorry, I couldn\'t generate a response.',
          type: 'text',
          timestamp: serverTimestamp(),
          groundingMetadata: response.candidates?.[0]?.groundingMetadata || null,
        });
      }

      // Update chat title if it's the first message
      if (messages.length === 0) {
        await setDoc(doc(db, 'chats', chatId), { title: input.slice(0, 30) }, { merge: true });
      }
      
      await setDoc(doc(db, 'chats', chatId), { updatedAt: serverTimestamp() }, { merge: true });

    } catch (err: any) {
      console.error('AI Error:', err);
      
      // Handle 403/404 errors by prompting for API key
      const errorMessage = err?.message || '';
      const errorStatus = err?.status || '';
      const nestedMessage = err?.error?.message || '';
      
      const isPermissionError = 
        errorMessage.includes('PERMISSION_DENIED') || 
        errorMessage.includes('The caller does not have permission') ||
        nestedMessage.includes('PERMISSION_DENIED') ||
        nestedMessage.includes('The caller does not have permission') ||
        errorStatus === 'PERMISSION_DENIED';
        
      const isNotFoundError = 
        errorMessage.includes('Requested entity was not found') || 
        nestedMessage.includes('Requested entity was not found');

      if (isPermissionError || isNotFoundError) {
        if (typeof window !== 'undefined' && window.aistudio) {
          await window.aistudio.openSelectKey();
        }
      }

      await addDoc(collection(db, `chats/${chatId}/messages`), {
        chatId,
        userId: user.uid,
        role: 'model',
        content: 'I encountered an error while processing your request. Please try again.',
        type: 'text',
        timestamp: serverTimestamp(),
      });
    } finally {
      setIsGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950">
        <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-zinc-950 p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full space-y-8"
        >
          <div className="flex flex-col items-center">
            <div className="w-20 h-20 bg-emerald-500/10 rounded-3xl flex items-center justify-center mb-6 border border-emerald-500/20">
              <Sparkles className="w-10 h-10 text-emerald-500" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-white mb-2">FRUBID AGENT</h1>
            <p className="text-zinc-400 text-lg">Your universal AI companion for research, coding, and creativity.</p>
          </div>
          
          <button
            onClick={handleLogin}
            disabled={isSigningIn}
            className="w-full py-4 px-6 bg-white text-zinc-950 font-semibold rounded-2xl flex items-center justify-center gap-3 hover:bg-zinc-200 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSigningIn ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <img src="https://www.google.com/favicon.ico" alt="Google" className="w-5 h-5" />
            )}
            Continue with Google
          </button>
          
          <p className="text-zinc-500 text-sm">
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-zinc-950 overflow-hidden">
      {/* Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        className={cn(
          "fixed inset-y-0 left-0 w-72 bg-zinc-900 border-r border-zinc-800 z-50 transform transition-transform duration-300 lg:relative lg:translate-x-0",
          !isSidebarOpen && "-translate-x-full"
        )}
      >
        <div className="flex flex-col h-full p-4">
          <div className="flex items-center justify-between mb-6 px-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-emerald-500" />
              <span className="font-bold text-lg">FRUBID AGENT</span>
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden p-1 text-zinc-400">
              <X className="w-5 h-5" />
            </button>
          </div>

            <button
              onClick={startNewChat}
              className="flex items-center gap-2 w-full p-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors mb-4 font-medium"
            >
              <Plus className="w-5 h-5" />
              New Chat
            </button>

            <div className="relative mb-6">
              <input
                type="text"
                placeholder="Search chats..."
                value={sidebarSearchQuery}
                onChange={(e) => setSidebarSearchQuery(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-xl py-2 pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
              />
              <History className="absolute right-3 top-2.5 w-4 h-4 text-zinc-500" />
            </div>

            <button
              onClick={() => setIsGlobalSearchOpen(true)}
              className="flex items-center gap-2 w-full p-3 mb-4 text-zinc-400 hover:text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-all border border-zinc-800 hover:border-emerald-500/30"
            >
              <Search className="w-5 h-5" />
              <span className="text-sm font-medium">Global Search</span>
            </button>

            <div className="flex-1 overflow-y-auto space-y-1">
              <div className="px-2 mb-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                <History className="w-3 h-3" />
                {sidebarSearchQuery ? 'Search Results' : 'Recent Chats'}
              </div>
              {filteredChatSessions.map((chat) => (
              <button
                key={chat.id}
                onClick={() => {
                  setCurrentChatId(chat.id);
                  setIsSidebarOpen(false);
                }}
                className={cn(
                  "w-full text-left p-3 rounded-xl text-sm transition-all truncate",
                  currentChatId === chat.id 
                    ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" 
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                )}
              >
                {chat.title}
              </button>
            ))}
          </div>

          <div className="mt-auto pt-4 border-t border-zinc-800">
            <div className="flex items-center gap-3 p-2 mb-2">
              <img 
                src={user.photoURL || ''} 
                alt="" 
                className="w-8 h-8 rounded-full bg-zinc-800" 
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user.displayName}</p>
                <p className="text-xs text-zinc-500 truncate">{user.email}</p>
              </div>
            </div>
            <button
              onClick={logout}
              className="flex items-center gap-2 w-full p-2 text-zinc-400 hover:text-red-400 transition-colors text-sm"
            >
              <LogOut className="w-4 h-4" />
              Logout
            </button>
          </div>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative min-w-0">
        {/* Header */}
        <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-4 lg:px-6 glass-panel">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 text-zinc-400">
              <Menu className="w-6 h-6" />
            </button>
            <h2 className="font-semibold truncate">
              {currentChatId ? chatSessions.find((c) => c.id === currentChatId)?.title : 'FRUBID AGENT'}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value as any)}
              className="bg-zinc-900 border border-zinc-800 text-[10px] sm:text-xs text-zinc-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 hover:border-zinc-700 transition-all cursor-pointer"
            >
              <option value="gemini-3-flash-preview">Gemini Flash (Fast)</option>
              <option value="gemini-3.1-pro-preview">Gemini Pro (Smart)</option>
              <option value="gemini-3.1-flash-lite-preview">Gemini Lite (Light)</option>
            </select>
            <div className="relative flex items-center">
              <AnimatePresence>
                {isChatSearchOpen && (
                  <motion.input
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 200, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    type="text"
                    placeholder="Search messages..."
                    value={chatSearchQuery}
                    onChange={(e) => setChatSearchQuery(e.target.value)}
                    className="bg-zinc-900 border border-zinc-800 rounded-full py-1 px-4 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 mr-2"
                  />
                )}
              </AnimatePresence>
              <button 
                onClick={() => {
                  setIsChatSearchOpen(!isChatSearchOpen);
                  if (isChatSearchOpen) setChatSearchQuery('');
                }}
                className={cn(
                  "p-2 rounded-full transition-colors",
                  isChatSearchOpen ? "bg-emerald-500/10 text-emerald-500" : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                <History className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>

        {/* Messages */}
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6 scroll-smooth"
        >
          {messages.length === 0 && !isGenerating && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-4 max-w-lg mx-auto">
              <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-2">
                <Bot className="w-8 h-8 text-emerald-500" />
              </div>
              <h3 className="text-xl font-bold">How can I help you today?</h3>
              <p className="text-zinc-400">
                I can help you with research, writing code, generating stunning images, or even creating short videos. Just ask!
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mt-4">
                {[
                  "Write a React hook for local storage",
                  "Generate an image of a cyberpunk city",
                  "Explain quantum entanglement",
                  "Create a video of a sunset on Mars"
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="p-3 text-sm text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800 hover:text-zinc-200 transition-all text-left"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {filteredMessages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex gap-3",
                msg.role === 'user' ? "flex-row-reverse" : "flex-row"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                msg.role === 'user' ? "bg-emerald-600" : "bg-zinc-800 border border-zinc-700"
              )}>
                {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5 text-emerald-500" />}
              </div>
              <div className={cn(
                "flex flex-col gap-2",
                msg.role === 'user' ? "items-end" : "items-start"
              )}>
                <div className={cn(
                  "relative group",
                  msg.role === 'user' ? "chat-bubble-user" : "chat-bubble-model"
                )}>
                  {msg.role === 'user' && (
                    <button
                      onClick={() => {
                        setEditingMessageId(msg.id);
                        setEditInput(msg.content);
                      }}
                      className="absolute -left-8 top-1/2 -translate-y-1/2 p-1.5 text-zinc-500 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity hover:text-emerald-500"
                      title="Edit message"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  )}
                  {msg.role === 'model' && (
                    <button
                      onClick={() => copyToClipboard(msg.content, msg.id)}
                      className="absolute -right-8 top-1/2 -translate-y-1/2 p-1.5 text-zinc-500 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity hover:text-emerald-500"
                      title="Copy message"
                    >
                      {copiedMessageId === msg.id ? (
                        <Check className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  )}
                  
                  <div className="prose prose-invert prose-sm max-w-none">
                    {editingMessageId === msg.id ? (
                      <div className="flex flex-col gap-2 min-w-[200px]">
                        <textarea
                          value={editInput}
                          onChange={(e) => setEditInput(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          rows={3}
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setEditingMessageId(null)}
                            className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleEditMessage(msg.id, editInput)}
                            className="px-2 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-500"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <Markdown
                        components={{
                          pre({ children, ...props }: any) {
                            return <CodeBlock {...props}>{children}</CodeBlock>;
                          },
                          code({ className, children, ...props }: any) {
                            return (
                              <code className={className} {...props}>
                                {children}
                              </code>
                            );
                          },
                        }}
                      >
                        {msg.content}
                      </Markdown>
                    )}
                  </div>

                  {msg.groundingMetadata?.groundingChunks && (
                    <div className="mt-4 pt-3 border-t border-zinc-800/50">
                      <div className="flex items-center gap-1.5 mb-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                        <Search className="w-3 h-3" />
                        Sources
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {msg.groundingMetadata.groundingChunks.map((chunk: any, i: number) => (
                          chunk.web && (
                            <a
                              key={i}
                              href={chunk.web.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 px-2 py-1 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-[10px] text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/30 transition-all"
                            >
                              <ExternalLink className="w-2.5 h-2.5" />
                              <span className="truncate max-w-[150px]">{chunk.web.title || 'Source'}</span>
                            </a>
                          )
                        ))}
                      </div>
                    </div>
                  )}

                  {msg.mediaUrl && (
                    <div className="mt-3 rounded-lg overflow-hidden border border-zinc-700">
                      {msg.type === 'image' ? (
                        <img 
                          src={msg.mediaUrl} 
                          alt="Generated" 
                          className="w-full h-auto max-h-[400px] object-contain"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <VideoPlayer src={msg.mediaUrl} />
                      )}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-zinc-600 px-1">
                  {msg.timestamp?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </motion.div>
          ))}

          {isGenerating && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex gap-3"
            >
              <div className="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0">
                <Bot className="w-5 h-5 text-emerald-500" />
              </div>
              <div className="chat-bubble-model flex items-center gap-2 py-3">
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                  <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-bounce" />
                </div>
                <span className="text-xs text-zinc-400 font-medium">FRUBID AGENT is thinking...</span>
              </div>
            </motion.div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-4 lg:p-6 border-t border-zinc-800 glass-panel">
          <div className="max-w-4xl mx-auto relative">
            <div className="absolute -top-6 left-0 flex items-center gap-1.5 text-[10px] font-medium text-zinc-500 transition-opacity duration-300">
              {isSavingDraft ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin text-emerald-500" />
                  <span>Saving draft...</span>
                </>
              ) : input ? (
                <>
                  <CloudCheck className="w-3 h-3 text-emerald-500/50" />
                  <span>Draft saved</span>
                </>
              ) : null}
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask anything..."
              rows={1}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl py-4 pl-4 pr-32 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-all resize-none min-h-[56px] max-h-32"
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as any)}
                className="bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-400 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 mr-1"
                title="Aspect Ratio"
              >
                <option value="1:1">1:1</option>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
              </select>
              <button
                onClick={() => handleSend('image')}
                disabled={isGenerating || !input.trim()}
                title="Generate Image"
                className="p-2 text-zinc-400 hover:text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ImageIcon className="w-5 h-5" />
              </button>
              <button
                onClick={() => handleSend('video')}
                disabled={isGenerating || !input.trim()}
                title="Generate Video"
                className="p-2 text-zinc-400 hover:text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <VideoIcon className="w-5 h-5" />
              </button>
              <button
                onClick={() => handleSend('text')}
                disabled={isGenerating || !input.trim()}
                className="p-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-500 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
          <p className="text-[10px] text-center text-zinc-600 mt-3">
            FRUBID AGENT can make mistakes. Check important info.
          </p>
        </div>
      </main>

      {/* Global Search Modal */}
      <AnimatePresence>
        {isGlobalSearchOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-4 border-b border-zinc-800 flex items-center gap-3">
                <Search className="w-5 h-5 text-emerald-500" />
                <input
                  autoFocus
                  type="text"
                  placeholder="Search across all conversations..."
                  value={globalSearchQuery}
                  onChange={(e) => setGlobalSearchQuery(e.target.value)}
                  className="flex-1 bg-transparent border-none focus:outline-none text-lg"
                />
                <button
                  onClick={() => setIsGlobalSearchOpen(false)}
                  className="p-2 hover:bg-zinc-800 rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {isSearchingGlobal ? (
                  <div className="flex flex-col items-center justify-center py-12 text-zinc-500 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <p>Searching through your history...</p>
                  </div>
                ) : globalSearchResults.length > 0 ? (
                  globalSearchResults.map((result) => (
                    <button
                      key={result.id}
                      onClick={() => {
                        setCurrentChatId(result.chatId);
                        setIsGlobalSearchOpen(false);
                      }}
                      className="w-full text-left p-4 rounded-xl border border-zinc-800 hover:border-emerald-500/30 hover:bg-emerald-500/5 transition-all group"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {result.role === 'user' ? (
                            <User className="w-3 h-3 text-zinc-500" />
                          ) : (
                            <Bot className="w-3 h-3 text-emerald-500" />
                          )}
                          <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                            {result.role === 'user' ? 'You' : 'Gemini'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-zinc-600">
                          <ExternalLink className="w-3 h-3" />
                          Go to chat
                        </div>
                      </div>
                      <p className="text-sm text-zinc-300 line-clamp-2 mb-2 group-hover:text-zinc-100">
                        {result.content}
                      </p>
                      <div className="text-[10px] text-zinc-600">
                        {result.timestamp?.toDate().toLocaleDateString()} at {result.timestamp?.toDate().toLocaleTimeString()}
                      </div>
                    </button>
                  ))
                ) : globalSearchQuery ? (
                  <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
                    <Search className="w-8 h-8 mb-2 opacity-20" />
                    <p>No messages found matching "{globalSearchQuery}"</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
                    <History className="w-8 h-8 mb-2 opacity-20" />
                    <p>Type to search across all your messages</p>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
