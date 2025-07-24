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
import logging
import sys

# Configure logging for uvicorn compatibility
def setup_logging():
    """Configure logging to work well with uvicorn"""
    # Get the root logger
    root_logger = logging.getLogger()
    
    # Clear any existing handlers
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
    
    # Create a formatter
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    # Create a stream handler (stdout)
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    stream_handler.setLevel(logging.DEBUG)
    
    # Add handler to root logger
    root_logger.addHandler(stream_handler)
    root_logger.setLevel(logging.INFO)
    
    # Configure specific loggers
    logging.getLogger("uvicorn").setLevel(logging.INFO)
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)
    logging.getLogger("uvicorn.access").setLevel(logging.INFO)
    logging.getLogger("litellm").setLevel(logging.WARNING)  # Reduce litellm verbosity
    logging.getLogger("httpx").setLevel(logging.WARNING)  # Reduce httpx verbosity
    
    return logging.getLogger(__name__)

# Setup logging
logger = setup_logging()

load_dotenv()

app = FastAPI(title="Roasted Chessnuts Backend")

@app.on_event("startup")
async def startup_event():
    """Initialize application on startup"""
    logger.info("=" * 60)
    logger.info("Starting Roasted Chessnuts Backend")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"OpenAI API Key configured: {'Yes' if os.getenv('OPENAI_API_KEY') else 'No'}")
    logger.info(f"LLM Model: {os.getenv('LLM_MODEL', 'gpt-3.5-turbo-0125')}")
    logger.info(f"Daisys TTS configured: {'Yes' if os.getenv('DAISYS_EMAIL') and os.getenv('DAISYS_PASSWORD') else 'No'}")
    logger.info("=" * 60)

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
        logger.info("Daisys API client created successfully")
    except Exception as e:
        logger.error(f"Failed to create Daisys API client: {str(e)}")
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

# Removed non-streaming /api/move endpoint - all moves now use /api/move-stream

@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "service": "Roasted Chessnuts"}

@app.get("/api/voice")
async def get_random_voice():
    """Get a random voice ID from the configured list"""
    import random
    
    if not DAISYS_VOICE_ID:
        raise HTTPException(status_code=500, detail="No voice IDs configured")
    
    # Split the space-separated list and pick a random one
    voice_ids = DAISYS_VOICE_ID.split()
    selected_voice = random.choice(voice_ids)
    
    logger.info(f"Selected voice ID: {selected_voice} from {len(voice_ids)} available voices")
    return {"voice_id": selected_voice}


@app.post("/api/websocket-url")
async def get_websocket_url():
    """Get a WebSocket URL for streaming TTS from Daisys (JSON response)"""
    if not daisys_client or not DAISYS_VOICE_ID:
        raise HTTPException(status_code=500, detail="TTS service not configured")
    
    # Use the first voice as default (the actual voice is passed per request)
    voice_ids = DAISYS_VOICE_ID.split()
    default_voice = voice_ids[0] if voice_ids else None
    
    try:
        with daisys_client as speak:
            # Get WebSocket URL for streaming
            ws_url = speak.websocket_url(voice_id=default_voice)
            return {"url": ws_url, "voice_id": default_voice}
    except Exception as e:
        logger.error(f"Error getting WebSocket URL: {str(e)}")
        logger.exception("WebSocket URL exception:")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/websocket-url-text")
@app.post("/api/websocket-url-text")
async def get_websocket_url_text():
    """Get a WebSocket URL for streaming TTS from Daisys (plain text response)"""
    from fastapi.responses import PlainTextResponse
    
    if not daisys_client or not DAISYS_VOICE_ID:
        raise HTTPException(status_code=500, detail="TTS service not configured")
    
    # Use the first voice as default (the actual voice is passed per request)
    voice_ids = DAISYS_VOICE_ID.split()
    default_voice = voice_ids[0] if voice_ids else None
    
    try:
        with daisys_client as speak:
            # Get WebSocket URL for streaming
            ws_url = speak.websocket_url(voice_id=default_voice)
            return PlainTextResponse(content=ws_url)
    except Exception as e:
        logger.error(f"Error getting WebSocket URL: {str(e)}")
        logger.exception("WebSocket URL exception:")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/move-stream")
async def process_move_stream(move_request: MoveRequest):
    """Stream commentary sentences as they are generated"""
    async def generate():
        try:
            logger.info(f"Processing move (streaming): {move_request.move} by {move_request.player}")
            
            # Prepare the prompt with FEN
            prompt = f"{move_request.move} by {move_request.player}. "
            prompt += f"The FEN so far: {move_request.fen}."
            logger.info(f'Prompt: {prompt}')
            
            # Check if OpenAI API key is set
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                logger.error("ERROR: OPENAI_API_KEY not set!")
                error_data = {'type': 'error', 'message': 'API key not configured'}
                yield f"data: {json.dumps(error_data)}\n\n"
                return
            
            logger.info(f"Using model: {os.getenv('LLM_MODEL', 'gpt-3.5-turbo-0125')}")
            
            # Track sentences
            current_sentence = ""
            sentence_count = 0
            full_commentary = ""
            
            # Different prompts for computer vs human
            if move_request.player == "computer":
                logger.info('computer move')
                system_prompt = "Describe computer's chess move in ONE short sentence (max 10 words). Be a bit patronizing to the human, or mock the AI if a bad move. Be savage."
            else:  # human
                logger.info('human move')
                system_prompt = "Roast this chess move in ONE short sentence (max 10 words). Be savage, no pleasantries. Relevant to the position, referencing games, openings, defenses, gambits, but be hilariously critical."
            
            # Stream the response
            response = await litellm.acompletion(
                model=os.getenv("LLM_MODEL", "gpt-3.5-turbo-0125"),
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=25,
                temperature=0.8,
                stream=True,
                timeout=10.0  # Increased timeout like non-streaming version
            )
            
            logger.debug("Starting to process LLM stream...")
            chunk_count = 0
            
            # Process streamed chunks
            async for chunk in response:
                chunk_count += 1
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
            
            logger.debug(f"Processed {chunk_count} chunks")
            
            # Log the generated commentary
            commentary = full_commentary.strip()
            logger.info(f"Generated commentary: {commentary}")
            
            # Send complete signal with full commentary
            data = {'type': 'complete', 'full_commentary': commentary}
            yield f"data: {json.dumps(data)}\n\n"
            
        except Exception as e:
            logger.error(f"Error in streaming: {str(e)}")
            logger.exception("Streaming exception traceback:")
            
            # Check if it's an LLM error
            if 'litellm' in str(type(e)).lower() or 'openai' in str(type(e)).lower():
                # Send a fallback commentary
                data = {'type': 'sentence', 'text': "That move was so bad, even the AI is speechless!", 'index': 0}
                yield f"data: {json.dumps(data)}\n\n"
                data = {'type': 'complete', 'full_commentary': "That move was so bad, even the AI is speechless!"}
                yield f"data: {json.dumps(data)}\n\n"
            else:
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
    # When running directly, configure uvicorn logging
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=8000,
        log_config={
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "default": {
                    "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
                    "datefmt": "%Y-%m-%d %H:%M:%S"
                }
            },
            "handlers": {
                "default": {
                    "formatter": "default",
                    "class": "logging.StreamHandler",
                    "stream": "ext://sys.stdout"
                }
            },
            "root": {
                "level": "INFO",
                "handlers": ["default"]
            },
            "loggers": {
                "uvicorn.error": {
                    "level": "INFO"
                },
                "uvicorn.access": {
                    "level": "INFO"
                }
            }
        }
    )
