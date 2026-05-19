from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import uuid
import psycopg2
import psycopg2.extras
from datetime import datetime, timedelta
import requests
import json

app = Flask(__name__)
CORS(app)

# Database connection
def get_db_connection():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise Exception("DATABASE_URL environment variable not set. Please add it in Railway Variables.")
    conn = psycopg2.connect(database_url)
    return conn

# Initialize database tables
def init_db():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        
        # Create licenses table
        cur.execute('''
            CREATE TABLE IF NOT EXISTS licenses (
                license_key TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                request_ip TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Create pending_sessions table
        cur.execute('''
            CREATE TABLE IF NOT EXISTS pending_sessions (
                session_token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                clicks_needed INTEGER DEFAULT 5,
                clicks_done INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                license_key TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        conn.commit()
        cur.close()
        conn.close()
        print("Database tables created/verified successfully")
    except Exception as e:
        print(f"Database initialization error: {e}")
        raise e

# Call init_db when app starts
try:
    init_db()
except Exception as e:
    print(f"Warning: Could not initialize database: {e}")
    print("Make sure DATABASE_URL environment variable is set in Railway")

# Configuration
YOUR_PASSWORD = "brute@2007"

# Frontend URL (for redirect)
FRONTEND_URL = os.environ.get('FRONTEND_URL', 'https://license-frontend.bruteexe2007.workers.dev')

# ---------- 1. Initialize license (user clicks "Get License") ----------
@app.route('/init-license', methods=['POST'])
def init_license():
    try:
        data = request.get_json()
        user_id = data.get('user_id')
        if not user_id:
            return jsonify({'error': 'user_id required'}), 400
        
        ip_address = request.headers.get('CF-Connecting-IP', request.remote_addr)
        session_token = str(uuid.uuid4())
        
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO pending_sessions (session_token, user_id, ip_address, clicks_needed, clicks_done, status) VALUES (%s, %s, %s, 5, 0, 'pending')",
            (session_token, user_id, ip_address)
        )
        conn.commit()
        cur.close()
        conn.close()
        
        # PTC URL with redirect back to claim page
        ptc_url = f"https://zerads.com/ptc.php?ref=11248&user={session_token}&redirect={FRONTEND_URL}/claim.html?token={session_token}"
        
        return jsonify({
            'success': True,
            'session_token': session_token,
            'ptc_url': ptc_url
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ---------- 2. Zerads callback ----------
@app.route('/zerads-callback', methods=['GET'])
def zerads_callback():
    try:
        pwd = request.args.get('pwd')
        session_token = request.args.get('user')
        clicks = int(request.args.get('clicks', 0))
        
        if pwd != YOUR_PASSWORD:
            return "Invalid password", 403
        
        if not session_token or clicks == 0:
            return "Missing user or clicks", 400
        
        conn = get_db_connection()
        cur = conn.cursor()
        
        # Get current session
        cur.execute(
            "SELECT clicks_done, clicks_needed, status, license_key FROM pending_sessions WHERE session_token = %s",
            (session_token,)
        )
        session = cur.fetchone()
        
        if not session:
            cur.close()
            conn.close()
            return "Session not found", 404
        
        clicks_done, clicks_needed, status, license_key = session
        
        if status == 'completed':
            cur.close()
            conn.close()
            return "Already completed", 200
        
        # Increment clicks
        new_clicks_done = clicks_done + clicks
        cur.execute(
            "UPDATE pending_sessions SET clicks_done = %s WHERE session_token = %s",
            (new_clicks_done, session_token)
        )
        
        # If completed, generate license
        if new_clicks_done >= clicks_needed and status != 'completed':
            new_license_key = str(uuid.uuid4())
            
            # Get user_id and ip_address
            cur.execute(
                "SELECT user_id, ip_address FROM pending_sessions WHERE session_token = %s",
                (session_token,)
            )
            user_id, ip_address = cur.fetchone()
            
            # Insert into licenses table
            cur.execute(
                "INSERT INTO licenses (license_key, user_id, request_ip, created_at) VALUES (%s, %s, %s, %s)",
                (new_license_key, user_id, ip_address, datetime.now())
            )
            
            # Update pending session
            cur.execute(
                "UPDATE pending_sessions SET status = 'completed', license_key = %s WHERE session_token = %s",
                (new_license_key, session_token)
            )
        
        conn.commit()
        cur.close()
        conn.close()
        
        return "OK", 200
    except Exception as e:
        return f"Error: {str(e)}", 500

# ---------- 3. Check session status ----------
@app.route('/check-session', methods=['GET'])
def check_session():
    try:
        session_token = request.args.get('session_token')
        if not session_token:
            return jsonify({'error': 'session_token required'}), 400
        
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT status, license_key, clicks_done, clicks_needed FROM pending_sessions WHERE session_token = %s",
            (session_token,)
        )
        session = cur.fetchone()
        cur.close()
        conn.close()
        
        if not session:
            return jsonify({'error': 'Session not found'}), 404
        
        status, license_key, clicks_done, clicks_needed = session
        
        if status == 'completed':
            return jsonify({
                'status': 'completed',
                'license_key': license_key
            }), 200
        else:
            return jsonify({
                'status': 'pending',
                'clicks_done': clicks_done,
                'clicks_needed': clicks_needed
            }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ---------- 4. Verify license (called by Python script) ----------
@app.route('/verify-license', methods=['POST'])
def verify_license():
    try:
        data = request.get_json()
        license_key = data.get('license_key')
        user_id = data.get('user_id')
        current_ip = request.headers.get('CF-Connecting-IP', request.remote_addr)
        
        if not license_key or not user_id:
            return jsonify({'valid': False, 'error': 'Missing license_key or user_id'}), 403
        
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT user_id, request_ip, created_at FROM licenses WHERE license_key = %s",
            (license_key,)
        )
        license_data = cur.fetchone()
        
        if not license_data:
            cur.close()
            conn.close()
            return jsonify({'valid': False, 'error': 'License not found'}), 403
        
        db_user_id, db_ip, created_at = license_data
        
        # Check user_id match
        if db_user_id != user_id:
            cur.close()
            conn.close()
            return jsonify({'valid': False, 'error': 'User ID mismatch'}), 403
        
        # Check expiry (1 hour)
        if datetime.now() - created_at > timedelta(hours=1):
            cur.execute("DELETE FROM licenses WHERE license_key = %s", (license_key,))
            conn.commit()
            cur.close()
            conn.close()
            return jsonify({'valid': False, 'error': 'License expired'}), 403
        
        # Check IP mismatch
        if db_ip != current_ip:
            cur.execute("DELETE FROM licenses WHERE license_key = %s", (license_key,))
            conn.commit()
            cur.close()
            conn.close()
            return jsonify({'valid': False, 'error': 'IP mismatch - license revoked'}), 403
        
        remaining_seconds = int((created_at + timedelta(hours=1) - datetime.now()).total_seconds())
        cur.close()
        conn.close()
        
        return jsonify({'valid': True, 'remaining_seconds': remaining_seconds}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ---------- Health check endpoint ----------
@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy'}), 200

# ---------- Root endpoint ----------
@app.route('/', methods=['GET'])
def root():
    return jsonify({
        'message': 'License API is running',
        'endpoints': ['/init-license', '/verify-license', '/check-session', '/zerads-callback', '/health']
    }), 200

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
