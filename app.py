from flask import Flask, render_template, jsonify
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# Konfigurasi Firebase dari environment variables
FIREBASE_CONFIG = {
    'apiKey': os.environ.get('FIREBASE_API_KEY'),
    'authDomain': os.environ.get('FIREBASE_AUTH_DOMAIN'),
    'databaseURL': os.environ.get('FIREBASE_DATABASE_URL'),
    'projectId': os.environ.get('FIREBASE_PROJECT_ID'),
    'storageBucket': os.environ.get('FIREBASE_STORAGE_BUCKET'),
}

@app.route('/')
def index():
    return render_template('index.html', firebase_config=FIREBASE_CONFIG)

@app.route('/api/config')
def get_config():
    return jsonify(FIREBASE_CONFIG)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
