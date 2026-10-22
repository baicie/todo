use axum::{
    Json,
    extract::{
        FromRequest, FromRequestParts, Query, Request,
        rejection::{JsonRejection, QueryRejection},
    },
    http::request::Parts,
};
use serde::de::DeserializeOwned;

use crate::error::AppError;

/// JSON extractor with the API's consistent `{code,message}` rejection shape.
pub struct ApiJson<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(map_json_rejection)
    }
}

/// Query-string extractor with the same error contract as `ApiJson`.
pub struct ApiQuery<T>(pub T);

impl<T, S> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(map_query_rejection)
    }
}

fn map_json_rejection(rejection: JsonRejection) -> AppError {
    // Do not include serde's rejection text here: it can quote unexpected field
    // values, which may contain task content.
    match rejection {
        JsonRejection::JsonDataError(_) | JsonRejection::JsonSyntaxError(_) => {
            AppError::validation("Request body must be valid JSON matching the endpoint schema")
        }
        JsonRejection::MissingJsonContentType(_) => {
            AppError::validation("Content-Type must be application/json")
        }
        JsonRejection::BytesRejection(_) => AppError::PayloadTooLarge,
        _ => AppError::validation("Invalid JSON request body"),
    }
}

fn map_query_rejection(rejection: QueryRejection) -> AppError {
    match rejection {
        QueryRejection::FailedToDeserializeQueryString(_) => {
            AppError::validation("Invalid query parameters")
        }
        _ => AppError::validation("Invalid query parameters"),
    }
}
