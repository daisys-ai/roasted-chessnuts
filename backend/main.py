from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os
from dotenv import load_dotenv
import litellm
from daisys import DaisysAPI
import asyncio
from typing import Optional
from pathlib import Path
import uuid
import time
import json

load_dotenv()

app = FastAPI(title="Roasted Chessnuts Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Daisys credentials from environment
DAISYS_EMAIL = os.getenv("DAISYS_EMAIL")
DAISYS_PASSWORD = os.getenv("DAISYS_PASSWORD")
DAISYS_VOICE_ID = os.getenv("DAISYS_VOICE_ID")

# Initialize Daisys API client globally
daisys_client = None
if DAISYS_EMAIL and DAISYS_PASSWORD:
    try:
        # Create the client but don't enter context yet
        daisys_client = DaisysAPI('speak', email=DAISYS_EMAIL, password=DAISYS_PASSWORD)
        print("Daisys API client created successfully")
    except Exception as e:
        print(f"Failed to create Daisys API client: {str(e)}")
        daisys_client = None

class MoveRequest(BaseModel):
    fen: str
    move: str
    player: str  # "human" or "computer"
    moveHistory: list[str]

class CommentaryResponse(BaseModel):
    commentary: str
    audioUrl: Optional[str] = None
    audioUrls: Optional[list[str]] = None  # Multiple audio URLs for sentence-by-sentence playback

@app.post("/api/move", response_model=CommentaryResponse)
async def process_move(move_request: MoveRequest):
    try:
        print(f"Processing move: {move_request.move} by {move_request.player}")
        
        # Even shorter prompt for maximum speed
        prompt = f"{move_request.move} by {move_request.player}"

        # Check if OpenAI API key is set
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            print("ERROR: OPENAI_API_KEY not set!")
            return CommentaryResponse(
                commentary="Nice move! (API key not configured)",
                audioUrl=None
            )
        
        print(f"Using model: {os.getenv('LLM_MODEL', 'gpt-3.5-turbo-0125')}")
        
        # Stream the response for faster perceived performance
        full_commentary = ""
        sentences = []
        current_sentence = ""
        
        try:
            response = await litellm.acompletion(
                model=os.getenv("LLM_MODEL", "gpt-3.5-turbo-0125"),  # Latest GPT-3.5 model
                messages=[
                    {"role": "system", "content": "Roast this chess move in EXACTLY 2 complete sentences. Be savage and sarcastic. Never start with 'Well, well, well' or similar phrases. Get straight to the roast. Make sure both sentences are complete with proper punctuation."},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=60,  # Enough for 2 complete sentences
                temperature=0.8,  # Slightly higher for more variety
                stream=True,  # Enable streaming
                timeout=10.0  # Increase timeout
            )
        except Exception as e:
            print(f"LLM Error: {str(e)}")
            print(f"Error type: {type(e)}")
            import traceback
            traceback.print_exc()
            return CommentaryResponse(
                commentary="That move was so bad, even the AI is speechless!",
                audioUrl=None
            )
        
        # Process streamed chunks
        print("Starting to process LLM stream...")
        chunk_count = 0
        async for chunk in response:
            chunk_count += 1
            if chunk.choices[0].delta.content:
                text = chunk.choices[0].delta.content
                full_commentary += text
                current_sentence += text
                
                # Check for sentence endings
                if any(p in text for p in ['.', '!', '?']):
                    sentences.append(current_sentence.strip())
                    current_sentence = ""
        
        print(f"Processed {chunk_count} chunks")
        
        # Add any remaining text as a sentence
        if current_sentence.strip():
            sentences.append(current_sentence.strip())
        
        commentary = full_commentary.strip()
        print(f"Generated commentary: {commentary}")
        
        # Generate TTS for each sentence as it arrives
        audio_url = None
        audio_urls = []
        tts_tasks = []
        
        async def generate_tts_for_sentence(text: str, index: int):
            if daisys_client and DAISYS_VOICE_ID:
                try:
                    with daisys_client as speak:
                        # Generate take without waiting for completion
                        take = speak.generate_take(
                            voice_id=DAISYS_VOICE_ID,
                            text=text,
                            wait=False  # Don't wait for completion
                        )
                        print(f"Started TTS for sentence {index}: {take.take_id}")
                        
                        # Poll for completion with timeout
                        start_time = time.time()
                        while time.time() - start_time < 2:  # 2 second timeout per sentence
                            take_status = speak.get_take(take.take_id)
                            if take_status.status == 'complete':
                                url = speak.get_take_audio_url(take.take_id)
                                return (index, url)
                            await asyncio.sleep(0.05)
                        
                        # If still not ready, return URL anyway
                        url = speak.get_take_audio_url(take.take_id)
                        return (index, url)
                except Exception as e:
                    print(f"Error generating TTS for sentence {index}: {str(e)}")
                    return (index, None)
            return (index, None)
        
        # Start TTS generation for each sentence
        for i, sentence in enumerate(sentences):
            if sentence:  # Only process non-empty sentences
                task = asyncio.create_task(generate_tts_for_sentence(sentence, i))
                tts_tasks.append(task)
        
        # Wait for all TTS tasks to complete
        if tts_tasks:
            results = await asyncio.gather(*tts_tasks)
            # Sort by index to maintain order
            results.sort(key=lambda x: x[0])
            audio_urls = [url for _, url in results if url]
            
            # Use the first audio URL as the main one
            if audio_urls:
                audio_url = audio_urls[0]
        
        return CommentaryResponse(
            commentary=commentary,
            audioUrl=audio_url,
            audioUrls=audio_urls if len(audio_urls) > 1 else None
        )
        
    except Exception as e:
        print(f"Error processing move: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "Roasted Chessnuts"}

@app.get("/test-llm")
async def test_llm():
    """Test if LLM is working"""
    try:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return {"error": "OPENAI_API_KEY not set"}
        
        response = await litellm.acompletion(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": "Say 'test passed'"}],
            max_tokens=10
        )
        
        return {
            "status": "success",
            "response": response.choices[0].message.content
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "type": str(type(e))
        }

@app.post("/api/websocket-url")
async def get_websocket_url():
    """Get a WebSocket URL for streaming TTS from Daisys (JSON response)"""
    if not daisys_client or not DAISYS_VOICE_ID:
        raise HTTPException(status_code=500, detail="TTS service not configured")
    
    try:
        with daisys_client as speak:
            # Get WebSocket URL for streaming
            ws_url = speak.websocket_url(voice_id=DAISYS_VOICE_ID)
            return {"url": ws_url, "voice_id": DAISYS_VOICE_ID}
    except Exception as e:
        print(f"Error getting WebSocket URL: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/websocket-url-text")
@app.post("/api/websocket-url-text")
async def get_websocket_url_text():
    """Get a WebSocket URL for streaming TTS from Daisys (plain text response)"""
    from fastapi.responses import PlainTextResponse
    
    if not daisys_client or not DAISYS_VOICE_ID:
        raise HTTPException(status_code=500, detail="TTS service not configured")
    
    try:
        with daisys_client as speak:
            # Get WebSocket URL for streaming
            ws_url = speak.websocket_url(voice_id=DAISYS_VOICE_ID)
            return PlainTextResponse(content=ws_url)
    except Exception as e:
        print(f"Error getting WebSocket URL: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/move-stream")
async def process_move_stream(move_request: MoveRequest):
    """Stream commentary sentences as they are generated"""
    async def generate():
        try:
            # Prepare the prompt
            prompt = f"{move_request.move} by {move_request.player}"
            
            # Track sentences
            current_sentence = ""
            sentence_count = 0
            full_commentary = ""
            
            # Stream the response
            response = await litellm.acompletion(
                model=os.getenv("LLM_MODEL", "gpt-3.5-turbo-0125"),
                messages=[
                    {"role": "system", "content": "Roast this chess move in EXACTLY 2 complete sentences. Be savage and sarcastic. Never start with 'Well, well, well' or similar phrases. Get straight to the roast. Make sure both sentences are complete with proper punctuation."},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=60,
                temperature=0.8,
                stream=True,
                timeout=5.0
            )
            
            # Process streamed chunks
            async for chunk in response:
                if chunk.choices[0].delta.content:
                    text = chunk.choices[0].delta.content
                    current_sentence += text
                    full_commentary += text
                    
                    # Check for sentence endings
                    for char in text:
                        if char in '.!?':
                            # Found end of sentence
                            sentence = current_sentence.strip()
                            if sentence:
                                data = {'type': 'sentence', 'text': sentence, 'index': sentence_count}
                                yield f"data: {json.dumps(data)}\n\n"
                                sentence_count += 1
                                current_sentence = ""
                            break
            
            # Send any remaining text as final sentence
            if current_sentence.strip():
                sentence = current_sentence.strip()
                data = {'type': 'sentence', 'text': sentence, 'index': sentence_count}
                yield f"data: {json.dumps(data)}\n\n"
            
            # Send complete signal with full commentary
            data = {'type': 'complete', 'full_commentary': full_commentary.strip()}
            yield f"data: {json.dumps(data)}\n\n"
            
        except Exception as e:
            print(f"Error in streaming: {str(e)}")
            error_data = {'type': 'error', 'message': str(e)}
            yield f"data: {json.dumps(error_data)}\n\n"
    
    return StreamingResponse(generate(), media_type="text/event-stream")

# API routes must be registered before static file serving
# This ensures API routes take precedence

# Serve Next.js static files - mount at the end to not override API routes
static_dir = Path("/app/static")
if static_dir.exists():
    # Mount static files AFTER all API routes are defined
    # Use a more specific path to avoid conflicts
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # Don't serve API routes as static files
        if full_path.startswith("api/") or full_path in ["health", "test-llm"]:
            raise HTTPException(status_code=404, detail="Not found")
        
        # Try to serve the requested file
        file_path = static_dir / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        
        # For client-side routing, serve index.html
        index_path = static_dir / "index.html"
        if index_path.exists():
            return FileResponse(index_path)
        
        raise HTTPException(status_code=404, detail="Not found")
else:
    # Fallback route for development
    @app.get("/{full_path:path}")
    async def serve_spa_dev(full_path: str):
        return {"message": "Frontend not built. Run npm run build and export."}

# Shutdown event removed - using context manager per request instead

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
